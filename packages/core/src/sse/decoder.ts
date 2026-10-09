/**
 * Incremental Server-Sent Events decoder.
 *
 * Implements the event-stream parsing rules of the WHATWG HTML Living Standard
 * (§9.2.6 "Interpreting an event stream") on top of raw bytes:
 *
 * - Input is any partition of the byte stream. Network chunk boundaries carry
 *   no meaning, and a chunk may hold zero, one or many events or end in the
 *   middle of a multi-byte character.
 * - Lines end in LF, CR or CRLF, including a CRLF split across two chunks.
 * - Line splitting happens on bytes, before UTF-8 decoding (see DECISIONS.md
 *   D-004). CR/LF never occur inside a multi-byte UTF-8 sequence, so every
 *   complete line holds complete characters unless the input is malformed.
 *   Malformed UTF-8 is reported with its byte offset and decoded with U+FFFD.
 * - Memory is bounded: an event block larger than `maxEventBytes` is discarded
 *   with a diagnostic, and the decoder resynchronises at the next blank line.
 *
 * The decoder is synchronous and does no I/O, so a given byte stream always
 * produces the same output regardless of how it is chunked.
 */
import { DEFAULT_LIMITS } from '@tokenfault/shared';
import type { DiagnosticCode, DiagnosticSeverity } from '@tokenfault/shared';

const LF = 0x0a;
const CR = 0x0d;
const COLON = 0x3a;
const SPACE = 0x20;

/** Upper bound on bytes appended to the internal buffer per step, so oversized events are detected early. */
const MAX_APPEND_SLICE = 64 * 1024;

export interface SseEvent {
  /** Event type. `"message"` when the block had no `event` field. */
  readonly type: string;
  /** Data lines joined with `\n`. */
  readonly data: string;
  /** The `id` field set inside this block, or `null`. */
  readonly id: string | null;
  /** The decoder's last-event-ID after this block (persists across events, per spec). */
  readonly lastEventId: string;
  /** The `retry` value set inside this block, or `null`. */
  readonly retry: number | null;
  /** Byte offset in the stream where the block started. */
  readonly startOffset: number;
  /**
   * Byte offset just past the terminator of the blank line that dispatched the
   * block. For a CRLF blank line this is past the CR: the trailing LF is not
   * attributed to any event, so offsets do not depend on chunk boundaries.
   */
  readonly endOffset: number;
  /** UTF-8 byte length of `data`. */
  readonly dataByteLength: number;
}

export interface SseDiagnostic {
  readonly code: Extract<DiagnosticCode, `sse-${string}`>;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Byte offset in the stream where the condition was detected. */
  readonly offset: number;
}

export type SseItem =
  | { readonly kind: 'event'; readonly event: SseEvent }
  | { readonly kind: 'comment'; readonly text: string; readonly offset: number }
  | { readonly kind: 'diagnostic'; readonly diagnostic: SseDiagnostic };

export interface SseDecoderOptions {
  /** Maximum bytes of a single event block, including field names and line terminators. */
  readonly maxEventBytes?: number;
  /** Emit `comment` items. Default `true`. */
  readonly emitComments?: boolean;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

export class SseDecoder {
  private readonly maxEventBytes: number;
  private readonly emitComments: boolean;

  // Byte buffer holding the not-yet-terminated line: buf[head, tail).
  private buf = new Uint8Array(1024);
  private head = 0;
  private tail = 0;

  /** Absolute stream offset of buf[head]. */
  private offset = 0;
  /** A CR terminated the previous line; an immediately following LF belongs to it. */
  private skipLf = false;
  private atStreamStart = true;
  private ended = false;

  // Current block state.
  private blockStart: number | null = null;
  private blockBytes = 0;
  private hasNonCommentField = false;
  private dataLines: string[] = [];
  private eventType = '';
  private blockId: string | null = null;
  private blockRetry: number | null = null;
  private lastEventIdBuffer = '';

  // Oversize recovery.
  private discarding = false;
  private discardLineHasBytes = false;
  /** Bytes after `head` already known not to contain CR or LF. Reset whenever `head` moves. */
  private scanned = 0;

  constructor(options: SseDecoderOptions = {}) {
    const max = options.maxEventBytes ?? DEFAULT_LIMITS.maxEventBytes;
    if (!Number.isSafeInteger(max) || max < 16) {
      throw new RangeError(`maxEventBytes must be an integer >= 16, got ${String(max)}`);
    }
    this.maxEventBytes = max;
    this.emitComments = options.emitComments ?? true;
  }

  /** Total bytes consumed so far. */
  get bytesConsumed(): number {
    return this.offset + (this.tail - this.head);
  }

  /** Feeds a chunk of bytes. Returns every item completed by this chunk, in stream order. */
  push(chunk: Uint8Array): SseItem[] {
    if (this.ended) throw new Error('SseDecoder.push() called after end()');
    const out: SseItem[] = [];
    for (let i = 0; i < chunk.length; i += MAX_APPEND_SLICE) {
      this.pushSlice(chunk.subarray(i, Math.min(chunk.length, i + MAX_APPEND_SLICE)), out);
    }
    return out;
  }

  /**
   * Signals end of stream. Per the specification, an event block that was not
   * terminated by a blank line is discarded. It is reported as
   * `sse-truncated-event` because an unterminated final event almost always
   * means a truncated response.
   */
  end(): SseItem[] {
    if (this.ended) return [];
    this.ended = true;
    const out: SseItem[] = [];
    const pendingLineBytes = this.tail - this.head;
    if (this.discarding) {
      this.resetBlock();
      return out;
    }
    if (pendingLineBytes > 0 || this.blockStart !== null) {
      const startOffset = this.blockStart ?? this.offset;
      const bytes = this.blockBytes + pendingLineBytes;
      out.push(
        diag(
          'sse-truncated-event',
          'warning',
          `Stream ended inside an unterminated event block (${bytes} bytes since offset ${startOffset} were not dispatched).`,
          startOffset,
        ),
      );
    }
    this.offset += pendingLineBytes;
    this.head = this.tail = 0;
    this.scanned = 0;
    this.resetBlock();
    return out;
  }

  private pushSlice(slice: Uint8Array, out: SseItem[]): void {
    if (slice.length === 0) return;
    this.append(slice);
    this.drainLines(out);
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const used = this.tail - this.head;
    const needed = used + bytes.length;
    if (
      this.head > 0 &&
      (this.tail + bytes.length > this.buf.length || this.head > this.buf.length / 2)
    ) {
      this.buf.copyWithin(0, this.head, this.tail);
      this.tail = used;
      this.head = 0;
    }
    if (this.tail + bytes.length > this.buf.length) {
      let capacity = this.buf.length;
      while (capacity < needed) capacity *= 2;
      const next = new Uint8Array(capacity);
      next.set(this.buf.subarray(this.head, this.tail), 0);
      this.buf = next;
      this.tail = used;
      this.head = 0;
    }
    this.buf.set(bytes, this.tail);
    this.tail += bytes.length;
  }

  private drainLines(out: SseItem[]): void {
    for (;;) {
      if (this.skipLf) {
        if (this.head === this.tail) return;
        this.skipLf = false;
        if (this.buf[this.head] === LF) {
          // The LF of a CRLF is not counted towards the block size: whether it is consumed here
          // or later depends on chunk boundaries, and the size limit must not.
          this.head += 1;
          this.scanned = 0;
          this.offset += 1;
        }
      }
      const terminator = this.findTerminator();
      if (terminator === -1) {
        this.checkPendingSize(out);
        return;
      }
      const lineStartOffset = this.offset;
      const line = this.buf.subarray(this.head, terminator);
      // A CR terminates the line immediately. An LF that directly follows it (CRLF) is
      // skipped on the next iteration, whether or not it is already buffered. The
      // line's consumed length is therefore independent of chunk boundaries.
      if (this.buf[terminator] === CR) this.skipLf = true;
      const consumed = terminator - this.head + 1;
      // Copy the line out before advancing, since processLine may trigger compaction later.
      const lineCopy = line.slice();
      this.head += consumed;
      this.scanned = 0;
      this.offset += consumed;
      this.processLine(lineCopy, lineStartOffset, consumed, out);
    }
  }

  /**
   * Finds the next CR or LF in buf[head, tail) with a single linear scan.
   * Bytes already scanned for the current pending line are not scanned again
   * (`scanned` is relative to `head`, so it survives buffer compaction). This
   * keeps decoding linear in the input size for any chunk size.
   */
  private findTerminator(): number {
    const buf = this.buf;
    for (let i = this.head + this.scanned; i < this.tail; i++) {
      const b = buf[i];
      if (b === LF || b === CR) {
        this.scanned = 0;
        return i;
      }
    }
    this.scanned = this.tail - this.head;
    return -1;
  }

  private checkPendingSize(out: SseItem[]): void {
    const pending = this.tail - this.head;
    if (this.discarding) {
      if (pending > 0) this.discardLineHasBytes = true;
      this.offset += pending;
      this.head = this.tail = 0;
      this.scanned = 0;
      this.scanned = 0;
      return;
    }
    if (this.blockBytes + pending > this.maxEventBytes) {
      this.enterDiscard(out, this.blockStart ?? this.offset);
      this.discardLineHasBytes = pending > 0;
      this.offset += pending;
      this.head = this.tail = 0;
      this.scanned = 0;
      this.scanned = 0;
    }
  }

  private enterDiscard(out: SseItem[], startOffset: number): void {
    out.push(
      diag(
        'sse-event-too-large',
        'error',
        `Event block starting at offset ${startOffset} exceeded maxEventBytes (${this.maxEventBytes}); discarded until the next blank line.`,
        startOffset,
      ),
    );
    this.resetBlock();
    this.discarding = true;
  }

  private processLine(
    line: Uint8Array,
    lineOffset: number,
    rawLength: number,
    out: SseItem[],
  ): void {
    if (this.discarding) {
      const lineEmpty = line.length === 0 && !this.discardLineHasBytes;
      this.discardLineHasBytes = false;
      if (lineEmpty) this.discarding = false;
      return;
    }

    let content = line;
    if (this.atStreamStart) {
      this.atStreamStart = false;
      if (
        content.length >= 3 &&
        content[0] === 0xef &&
        content[1] === 0xbb &&
        content[2] === 0xbf
      ) {
        content = content.subarray(3);
        out.push(
          diag(
            'sse-bom',
            'info',
            'Stream starts with a UTF-8 byte order mark; it was stripped.',
            lineOffset,
          ),
        );
      }
    }

    if (content.length === 0) {
      this.dispatch(lineOffset + rawLength, out);
      return;
    }

    if (this.blockStart === null) {
      this.blockStart = lineOffset;
      this.blockBytes = 0;
    }
    this.blockBytes += rawLength;
    if (this.blockBytes > this.maxEventBytes) {
      this.enterDiscard(out, this.blockStart);
      return;
    }

    const text = this.decodeLine(content, lineOffset, out);

    if (content[0] === COLON) {
      if (this.emitComments) {
        const body = content.length > 1 && content[1] === SPACE ? text.slice(2) : text.slice(1);
        out.push({ kind: 'comment', text: body, offset: lineOffset });
      }
      return;
    }

    const colon = text.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = text;
      value = '';
    } else {
      field = text.slice(0, colon);
      value = text.charCodeAt(colon + 1) === SPACE ? text.slice(colon + 2) : text.slice(colon + 1);
    }

    switch (field) {
      case 'data':
        this.hasNonCommentField = true;
        this.dataLines.push(value);
        return;
      case 'event':
        this.hasNonCommentField = true;
        this.eventType = value;
        return;
      case 'id':
        this.hasNonCommentField = true;
        if (value.includes('\u0000')) {
          out.push(
            diag(
              'sse-id-contains-null',
              'warning',
              'Ignored an `id` field containing U+0000 NULL.',
              lineOffset,
            ),
          );
        } else {
          this.lastEventIdBuffer = value;
          this.blockId = value;
        }
        return;
      case 'retry':
        this.hasNonCommentField = true;
        if (/^[0-9]+$/.test(value)) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isSafeInteger(parsed)) this.blockRetry = parsed;
        } else {
          out.push(
            diag(
              'sse-invalid-retry',
              'warning',
              `Ignored non-numeric retry value "${truncate(value, 40)}".`,
              lineOffset,
            ),
          );
        }
        return;
      default:
        this.hasNonCommentField = true;
        out.push(
          diag(
            'sse-unknown-field',
            'warning',
            `Ignored unknown field "${truncate(field, 64)}"${colon === -1 ? ' (line has no colon)' : ''}.`,
            lineOffset,
          ),
        );
    }
  }

  private decodeLine(bytes: Uint8Array, lineOffset: number, out: SseItem[]): string {
    try {
      return strictUtf8.decode(bytes);
    } catch {
      const bad = firstInvalidUtf8Index(bytes);
      out.push(
        diag(
          'sse-invalid-utf8',
          'error',
          `Invalid UTF-8 at byte offset ${lineOffset + (bad === -1 ? 0 : bad)}; replaced with U+FFFD.`,
          lineOffset + (bad === -1 ? 0 : bad),
        ),
      );
      return lenientUtf8.decode(bytes);
    }
  }

  private dispatch(endOffset: number, out: SseItem[]): void {
    const startOffset = this.blockStart;
    if (startOffset === null) return; // Consecutive blank lines: nothing to dispatch.
    if (this.dataLines.length === 0) {
      if (this.hasNonCommentField) {
        out.push(
          diag(
            'sse-empty-event',
            'info',
            'Event block without a data field was not dispatched (per the SSE specification).',
            startOffset,
          ),
        );
      }
      this.resetBlock();
      return;
    }
    const data = this.dataLines.join('\n');
    out.push({
      kind: 'event',
      event: {
        type: this.eventType === '' ? 'message' : this.eventType,
        data,
        id: this.blockId,
        lastEventId: this.lastEventIdBuffer,
        retry: this.blockRetry,
        startOffset,
        endOffset,
        dataByteLength: utf8ByteLength(data),
      },
    });
    this.resetBlock();
  }

  private resetBlock(): void {
    this.blockStart = null;
    this.blockBytes = 0;
    this.hasNonCommentField = false;
    this.dataLines = [];
    this.eventType = '';
    this.blockId = null;
    this.blockRetry = null;
  }
}

function diag(
  code: SseDiagnostic['code'],
  severity: DiagnosticSeverity,
  message: string,
  offset: number,
): SseItem {
  return { kind: 'diagnostic', diagnostic: { code, severity, message, offset } };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function utf8ByteLength(text: string): number {
  // Fast path for ASCII-only strings.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) {
      ascii = false;
      break;
    }
  }
  return ascii ? text.length : utf8Encoder.encode(text).length;
}

/**
 * Returns the index of the first byte that starts an invalid UTF-8 sequence,
 * or -1 if the input is valid. Follows the well-formedness table in Unicode
 * §3.9 (Table 3-7): no overlongs, no surrogates, max U+10FFFF.
 */
export function firstInvalidUtf8Index(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      i += 1;
      continue;
    }
    let needed: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) needed = 1;
    else if (b0 === 0xe0) {
      needed = 2;
      lo = 0xa0;
    } else if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) needed = 2;
    else if (b0 === 0xed) {
      needed = 2;
      hi = 0x9f;
    } else if (b0 === 0xf0) {
      needed = 3;
      lo = 0x90;
    } else if (b0 >= 0xf1 && b0 <= 0xf3) needed = 3;
    else if (b0 === 0xf4) {
      needed = 3;
      hi = 0x8f;
    } else return i;
    if (i + needed > bytes.length - 1) return i; // Truncated sequence.
    const b1 = bytes[i + 1];
    if (b1 === undefined || b1 < lo || b1 > hi) return i;
    for (let k = 2; k <= needed; k++) {
      const b = bytes[i + k];
      if (b === undefined || b < 0x80 || b > 0xbf) return i;
    }
    i += needed + 1;
  }
  return -1;
}
