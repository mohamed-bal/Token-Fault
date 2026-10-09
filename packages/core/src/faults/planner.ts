/**
 * Fault planner: a deterministic function from (fault profile, seed, observed
 * frames) to a list of actions. It performs no I/O and reads no clocks, so the
 * same inputs always produce the same plan (DECISIONS.md D-008).
 *
 * The planner works in two phases, because an HTTP status cannot change once
 * headers are sent:
 *
 * 1. `preResponse()`: first-byte delay and HTTP error responses, decided
 *    before any byte is written.
 * 2. `planFrame()` / `planEnd()`: in-stream faults (stalls, jitter,
 *    fragmentation, malformed data, disconnects), decided per SSE frame.
 */
import { deriveSeed, mulberry32, randomInt } from './rng.js';
import type { Rng } from './rng.js';
import type { DisconnectMode, FaultProfile, FaultSpec, MalformedKind } from './schema.js';

type Of<T extends FaultSpec['type']> = Extract<FaultSpec, { type: T }>;

export type FaultAction =
  | { readonly kind: 'wait'; readonly ms: number; readonly faultType: FaultSpec['type'] }
  | { readonly kind: 'write'; readonly bytes: Uint8Array; readonly injected: boolean }
  | { readonly kind: 'annotate'; readonly faultType: FaultSpec['type']; readonly message: string }
  | {
      readonly kind: 'disconnect';
      readonly mode: DisconnectMode;
      readonly faultType: FaultSpec['type'];
    };

export interface FrameInfo {
  readonly bytes: Uint8Array;
  /** The frame dispatches an SSE event (as opposed to a comment-only or blank frame). */
  readonly isEvent: boolean;
  /** The event carries a non-empty content delta or tool-call delta. */
  readonly hasContent: boolean;
}

export interface PreResponsePlan {
  readonly delayMs: number;
  readonly error: Of<'http-error'> | null;
}

const enc = new TextEncoder();

export function malformedFrame(kind: MalformedKind): Uint8Array {
  switch (kind) {
    case 'truncated-json':
      return enc.encode(
        'data: {"id":"tokenfault-malformed","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"trunc\n\n',
      );
    case 'invalid-utf8':
      return new Uint8Array([
        ...enc.encode(
          'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"bad ',
        ),
        0xc3,
        0x28,
        ...enc.encode('"}}]}\n\n'),
      ]);
    case 'missing-blank-line':
      // A single newline makes the following real event's data merge into this block.
      return enc.encode('data: {"object":"chat.completion.chunk","choices":[]}\n');
    case 'unknown-field':
      return enc.encode('dta: {"object":"chat.completion.chunk","choices":[]}\n\n');
    case 'html-error-page':
      return enc.encode('<html><body><h1>502 Bad Gateway</h1></body></html>\n\n');
  }
}

export class FaultPlanner {
  private readonly faults: Map<FaultSpec['type'], FaultSpec>;
  private readonly jitterRng: Rng | null;
  private readonly fragmentRng: Rng | null;
  private deliveredEvents = 0;
  private stallDone = false;
  private malformedDone = false;
  private firstContentDone = false;
  private jitterAnnounced = false;
  private fragmentAnnounced = false;
  private disconnected = false;

  constructor(readonly profile: FaultProfile) {
    this.faults = new Map(profile.faults.map((f) => [f.type, f]));
    this.jitterRng = this.faults.has('jitter')
      ? mulberry32(deriveSeed(profile.seed, 'jitter'))
      : null;
    this.fragmentRng = this.faults.has('fragment')
      ? mulberry32(deriveSeed(profile.seed, 'fragment'))
      : null;
  }

  private get<T extends FaultSpec['type']>(type: T): Of<T> | undefined {
    return this.faults.get(type) as Of<T> | undefined;
  }

  /** True when any fault needs frame-level control of the response body. */
  get needsFraming(): boolean {
    return (
      this.faults.has('delay-first-content') ||
      this.faults.has('stall') ||
      this.faults.has('jitter') ||
      this.faults.has('fragment') ||
      this.faults.has('malformed') ||
      this.get('disconnect')?.afterEvents !== undefined
    );
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  get eventsDelivered(): number {
    return this.deliveredEvents;
  }

  preResponse(): PreResponsePlan {
    return {
      delayMs: this.get('delay-first-byte')?.delayMs ?? 0,
      error: this.get('http-error') ?? null,
    };
  }

  /** Time-based disconnect, armed by the executor when headers are sent. */
  timedDisconnect(): { readonly afterMs: number; readonly mode: DisconnectMode } | null {
    const d = this.get('disconnect');
    return d?.afterMs !== undefined ? { afterMs: d.afterMs, mode: d.mode } : null;
  }

  /** Records that a time-based disconnect fired, so later frames are not planned. */
  markDisconnected(): void {
    this.disconnected = true;
  }

  planFrame(frame: FrameInfo): FaultAction[] {
    if (this.disconnected) return [];
    const actions: FaultAction[] = [];

    if (frame.isEvent) {
      const disconnect = this.get('disconnect');
      if (disconnect?.afterEvents !== undefined && this.deliveredEvents >= disconnect.afterEvents) {
        this.disconnected = true;
        actions.push(
          {
            kind: 'annotate',
            faultType: 'disconnect',
            message: `Connection terminated (${disconnect.mode}) after ${this.deliveredEvents} events.`,
          },
          { kind: 'disconnect', mode: disconnect.mode, faultType: 'disconnect' },
        );
        return actions;
      }

      const stall = this.get('stall');
      if (stall && !this.stallDone && this.deliveredEvents >= stall.afterEvents) {
        this.stallDone = true;
        actions.push(
          {
            kind: 'annotate',
            faultType: 'stall',
            message: `Stalling for ${stall.durationMs} ms after ${this.deliveredEvents} events.`,
          },
          { kind: 'wait', ms: stall.durationMs, faultType: 'stall' },
        );
      }

      const malformed = this.get('malformed');
      if (malformed && !this.malformedDone && this.deliveredEvents >= malformed.afterEvents) {
        this.malformedDone = true;
        actions.push(
          {
            kind: 'annotate',
            faultType: 'malformed',
            message: `Injected a deliberately malformed frame (${malformed.kind}) after ${this.deliveredEvents} events.`,
          },
          { kind: 'write', bytes: malformedFrame(malformed.kind), injected: true },
        );
      }

      const firstContent = this.get('delay-first-content');
      if (firstContent && !this.firstContentDone && frame.hasContent) {
        this.firstContentDone = true;
        actions.push(
          {
            kind: 'annotate',
            faultType: 'delay-first-content',
            message: `Delaying the first content delta by ${firstContent.delayMs} ms.`,
          },
          { kind: 'wait', ms: firstContent.delayMs, faultType: 'delay-first-content' },
        );
      }

      const jitter = this.get('jitter');
      if (jitter && this.jitterRng && this.deliveredEvents > 0) {
        const ms = randomInt(this.jitterRng, jitter.minGapMs, jitter.maxGapMs);
        if (!this.jitterAnnounced) {
          this.jitterAnnounced = true;
          actions.push({
            kind: 'annotate',
            faultType: 'jitter',
            message: `Jitter active: adding ${jitter.minGapMs}–${jitter.maxGapMs} ms before each event (seed ${this.profile.seed}).`,
          });
        }
        if (ms > 0) actions.push({ kind: 'wait', ms, faultType: 'jitter' });
      }
    }

    actions.push(...this.writeFrame(frame.bytes));
    if (frame.isEvent) this.deliveredEvents += 1;
    return actions;
  }

  /** Called once the source stream ended. Reports faults that were configured but never triggered. */
  planEnd(): FaultAction[] {
    if (this.disconnected) return [];
    const actions: FaultAction[] = [];
    const malformed = this.get('malformed');
    if (malformed && !this.malformedDone) {
      this.malformedDone = true;
      actions.push(
        {
          kind: 'annotate',
          faultType: 'malformed',
          message: `Stream ended after ${this.deliveredEvents} events, before afterEvents=${malformed.afterEvents}; malformed frame (${malformed.kind}) injected at the end.`,
        },
        { kind: 'write', bytes: malformedFrame(malformed.kind), injected: true },
      );
    }
    const stall = this.get('stall');
    if (stall && !this.stallDone) {
      actions.push({
        kind: 'annotate',
        faultType: 'stall',
        message: `Stall not triggered: stream had only ${this.deliveredEvents} events (afterEvents=${stall.afterEvents}).`,
      });
    }
    const disconnect = this.get('disconnect');
    if (disconnect?.afterEvents !== undefined) {
      actions.push({
        kind: 'annotate',
        faultType: 'disconnect',
        message: `Disconnect not triggered: stream had only ${this.deliveredEvents} events (afterEvents=${disconnect.afterEvents}).`,
      });
    }
    return actions;
  }

  private writeFrame(bytes: Uint8Array): FaultAction[] {
    const fragment = this.get('fragment');
    if (!fragment || !this.fragmentRng || bytes.length === 0)
      return [{ kind: 'write', bytes, injected: false }];
    const actions: FaultAction[] = [];
    if (!this.fragmentAnnounced) {
      this.fragmentAnnounced = true;
      actions.push({
        kind: 'annotate',
        faultType: 'fragment',
        message: `Fragmenting frames into ${fragment.minChunkBytes}–${fragment.maxChunkBytes} byte writes (seed ${this.profile.seed}).`,
      });
    }
    let offset = 0;
    while (offset < bytes.length) {
      const size = randomInt(this.fragmentRng, fragment.minChunkBytes, fragment.maxChunkBytes);
      if (offset > 0 && fragment.interChunkDelayMs > 0) {
        actions.push({ kind: 'wait', ms: fragment.interChunkDelayMs, faultType: 'fragment' });
      }
      actions.push({
        kind: 'write',
        bytes: bytes.subarray(offset, offset + size),
        injected: false,
      });
      offset += size;
    }
    return actions;
  }
}
