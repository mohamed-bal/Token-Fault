/**
 * Writes a source byte stream to a Node `ServerResponse` through the fault
 * engine: frames → classification → plan → execution with backpressure.
 * The mock server (synthetic source) and the proxy (upstream source) both use it.
 */
import type { ServerResponse } from 'node:http';
import { FrameClassifier } from '../faults/classify.js';
import { WaitPacer, executeFaultActions } from '../faults/executor.js';
import type { FaultSink } from '../faults/executor.js';
import type { FaultPlanner } from '../faults/planner.js';
import type { DisconnectMode, FaultType } from '../faults/schema.js';
import { SseFramer } from '../sse/framer.js';
import { terminateResponse, writeWithBackpressure } from './response.js';

export interface FaultedWriterHooks {
  /** Called after bytes were accepted by the socket. */
  onWrite(bytes: Uint8Array, injected: boolean): void;
  onAnnotate(faultType: FaultType, message: string, afterEvents: number): void;
  /** Called once when a fault terminated the connection. */
  onDisconnect(mode: DisconnectMode, faultType: FaultType): void;
}

export class FaultedResponseWriter {
  private readonly framer: SseFramer;
  private readonly classifier: FrameClassifier;
  private readonly internal = new AbortController();
  private readonly signal: AbortSignal;
  private timer: NodeJS.Timeout | null = null;
  private disconnectedFlag = false;
  private readonly sink: FaultSink;
  /** One pacer per response, so timer overshoot is compensated across frames. */
  private readonly pacer = new WaitPacer();
  /** Frame-level faults are applied only to SSE bodies; otherwise bytes pass through untouched. */
  private readonly framing: boolean;

  constructor(
    private readonly res: ServerResponse,
    private readonly planner: FaultPlanner,
    private readonly hooks: FaultedWriterHooks,
    externalSignal: AbortSignal,
    options: { readonly framing?: boolean; readonly maxEventBytes?: number } = {},
  ) {
    const maxEventBytes = options.maxEventBytes;
    this.framing = (options.framing ?? true) && planner.needsFraming;
    this.framer = new SseFramer(
      maxEventBytes === undefined ? {} : { maxFrameBytes: maxEventBytes },
    );
    this.classifier = new FrameClassifier(maxEventBytes);
    this.signal = AbortSignal.any([externalSignal, this.internal.signal]);
    this.sink = {
      write: async (bytes, injected) => {
        await writeWithBackpressure(this.res, bytes);
        this.hooks.onWrite(bytes, injected);
      },
      disconnect: (mode, faultType) => this.disconnect(mode, faultType),
      annotate: (faultType, message) =>
        this.hooks.onAnnotate(faultType, message, this.planner.eventsDelivered),
    };
  }

  get disconnected(): boolean {
    return this.disconnectedFlag;
  }

  /** Arms time-based faults. Call right after the response headers were written. */
  start(): void {
    const timed = this.planner.timedDisconnect();
    if (!timed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disconnectedFlag) return;
      this.planner.markDisconnected();
      this.hooks.onAnnotate(
        'disconnect',
        `Connection terminated (${timed.mode}) ${timed.afterMs} ms after headers.`,
        this.planner.eventsDelivered,
      );
      this.disconnect(timed.mode, 'disconnect');
    }, timed.afterMs);
  }

  /** Feeds source bytes. Resolves `false` once the stream must stop (disconnect or abort). */
  async push(bytes: Uint8Array): Promise<boolean> {
    if (!this.framing) {
      if (this.disconnectedFlag || this.signal.aborted) return false;
      await this.sink.write(bytes, false);
      return !this.disconnectedFlag && !this.signal.aborted;
    }
    for (const frame of this.framer.push(bytes)) {
      if (!(await this.runFrame(frame.bytes))) return false;
    }
    return !this.disconnectedFlag && !this.signal.aborted;
  }

  /** Flushes buffered bytes and end-of-stream faults. Resolves `false` if the stream was cut. */
  async end(): Promise<boolean> {
    if (!this.framing) return !this.disconnectedFlag && !this.signal.aborted;
    for (const frame of this.framer.end()) {
      if (!(await this.runFrame(frame.bytes))) return false;
    }
    if (this.disconnectedFlag || this.signal.aborted) return false;
    const result = await executeFaultActions(
      this.planner.planEnd(),
      this.sink,
      this.signal,
      this.pacer,
    );
    return result === 'open';
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runFrame(bytes: Uint8Array): Promise<boolean> {
    if (this.disconnectedFlag || this.signal.aborted) return false;
    const actions = this.planner.planFrame(this.classifier.classify(bytes));
    const result = await executeFaultActions(actions, this.sink, this.signal, this.pacer);
    return result === 'open';
  }

  private disconnect(mode: DisconnectMode, faultType: FaultType): void {
    if (this.disconnectedFlag) return;
    this.disconnectedFlag = true;
    this.dispose();
    this.internal.abort();
    terminateResponse(this.res, mode);
    this.hooks.onDisconnect(mode, faultType);
  }
}
