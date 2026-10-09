/**
 * Byte-exact SSE frame splitter.
 *
 * Splits a byte stream into raw frames, each ending with the blank line that
 * terminates an event block. The concatenation of all emitted frames always
 * equals the input stream. No byte is added, dropped or re-encoded.
 *
 * The proxy uses it to apply event-level faults (delays, disconnects,
 * re-chunking) to a live upstream stream without rewriting the stream.
 *
 * Memory is bounded: if a frame grows beyond `maxFrameBytes` without a
 * terminating blank line, the bytes buffered so far are flushed as an
 * incomplete frame (`complete: false`).
 */
import { DEFAULT_LIMITS } from '@tokenfault/shared';

const LF = 0x0a;
const CR = 0x0d;

export interface SseFrame {
  readonly bytes: Uint8Array;
  /** `true` when the frame ends with a blank line; `false` for a forced flush or the stream tail. */
  readonly complete: boolean;
}

export class SseFramer {
  private readonly maxFrameBytes: number;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  /** Bytes in the current line, excluding its terminator. */
  private lineLength = 0;
  /** The previous byte was a CR, so an LF now is part of the same terminator. */
  private prevCr = false;
  /** A blank line ended with CR. The frame ends here unless the next byte is LF. */
  private awaitingLf = false;

  constructor(options: { readonly maxFrameBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_LIMITS.maxEventBytes;
  }

  push(chunk: Uint8Array): SseFrame[] {
    const frames: SseFrame[] = [];
    let segmentStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      if (this.awaitingLf) {
        this.awaitingLf = false;
        if (b === LF) {
          this.prevCr = false;
          frames.push(this.take(chunk, segmentStart, i + 1, true));
          segmentStart = i + 1;
          continue;
        }
        // Frame ended at the CR; this byte starts the next frame.
        frames.push(this.take(chunk, segmentStart, i, true));
        segmentStart = i;
      }
      if (b === LF) {
        if (this.prevCr) {
          // Second half of a CRLF whose CR already terminated a non-blank line.
          this.prevCr = false;
          continue;
        }
        if (this.lineLength === 0) {
          frames.push(this.take(chunk, segmentStart, i + 1, true));
          segmentStart = i + 1;
        }
        this.lineLength = 0;
      } else if (b === CR) {
        if (this.lineLength === 0) {
          this.awaitingLf = true;
          this.prevCr = false;
        } else {
          this.prevCr = true;
        }
        this.lineLength = 0;
      } else {
        this.prevCr = false;
        this.lineLength += 1;
      }
    }
    if (segmentStart < chunk.length) {
      const rest = chunk.subarray(segmentStart);
      this.pending.push(rest.slice());
      this.pendingBytes += rest.length;
    }
    if (this.pendingBytes > this.maxFrameBytes && !this.awaitingLf) {
      frames.push({ bytes: this.flushPending(), complete: false });
    }
    return frames;
  }

  /** Flushes any buffered bytes as the final frame. */
  end(): SseFrame[] {
    if (this.awaitingLf) {
      this.awaitingLf = false;
      return this.pendingBytes > 0 ? [{ bytes: this.flushPending(), complete: true }] : [];
    }
    if (this.pendingBytes === 0) return [];
    return [{ bytes: this.flushPending(), complete: false }];
  }

  private take(chunk: Uint8Array, from: number, to: number, complete: boolean): SseFrame {
    const tail = chunk.subarray(from, to);
    if (this.pendingBytes === 0) return { bytes: tail.slice(), complete };
    const out = new Uint8Array(this.pendingBytes + tail.length);
    let pos = 0;
    for (const piece of this.pending) {
      out.set(piece, pos);
      pos += piece.length;
    }
    out.set(tail, pos);
    this.pending = [];
    this.pendingBytes = 0;
    return { bytes: out, complete };
  }

  private flushPending(): Uint8Array {
    const out = new Uint8Array(this.pendingBytes);
    let pos = 0;
    for (const piece of this.pending) {
      out.set(piece, pos);
      pos += piece.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    return out;
  }
}
