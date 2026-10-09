/**
 * Executes planned fault actions against a sink. Platform-agnostic: the sink
 * implementation (Node `ServerResponse`, in-memory, ...) handles backpressure
 * and transport-level disconnects.
 */
import type { FaultAction } from './planner.js';
import type { DisconnectMode, FaultType } from './schema.js';

export interface FaultSink {
  /** Writes bytes and resolves once the transport accepted them (backpressure-aware). */
  write(bytes: Uint8Array, injected: boolean): Promise<void>;
  /** Terminates the transport. Must be idempotent. */
  disconnect(mode: DisconnectMode, faultType: FaultType): void;
  /** Records a human-readable fault annotation. */
  annotate(faultType: FaultType, message: string): void;
}

/** Largest delay a single Node/browser timer supports. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Resolves `true` after `ms`, or `false` as soon as `signal` aborts. Never
 * rejects, so callers cannot leak an unhandled rejection from a cancelled wait.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!(ms > 0)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = ms;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    // Timers overflow above 2^31-1 ms (about 24.8 days) and would fire after 1 ms; long waits are chained.
    const schedule = (): void => {
      const step = Math.min(remaining, MAX_TIMER_MS);
      timer = setTimeout(() => {
        remaining -= step;
        if (remaining > 0) {
          schedule();
          return;
        }
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, step);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    schedule();
  });
}

/** Upper bound on the timer overshoot a pacer carries forward (see `WaitPacer`). */
const MAX_DEBT_MS = 50;

const yieldTurn: () => Promise<void> = (() => {
  const immediate = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;
  return immediate
    ? () => new Promise<void>((resolve) => void immediate(resolve))
    : () => new Promise<void>((resolve) => void setTimeout(resolve, 0));
})();

/**
 * Keeps a run of short fault waits on schedule when the platform timer is coarse.
 *
 * Timers overshoot: on Windows a 1 ms `setTimeout` takes about 15.6 ms, so a fragmentation
 * fault with thousands of 1 ms gaps took 15× longer than configured. The pacer measures each
 * overshoot and subtracts it from the following waits (at most `MAX_DEBT_MS` is carried), so
 * the total injected delay matches the profile. Waits that are fully paid off by earlier
 * overshoot still yield one event-loop turn, so consecutive writes stay separate writes.
 * Use one pacer per stream.
 */
export class WaitPacer {
  private debtMs = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** Resolves `true` after (about) `ms`, or `false` as soon as `signal` aborts. */
  async wait(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (!(ms > 0)) return true;
    if (this.debtMs >= ms) {
      this.debtMs -= ms;
      await yieldTurn();
      return !signal?.aborted;
    }
    const target = ms - this.debtMs;
    const started = this.clock();
    const completed = await sleep(target, signal);
    this.debtMs = Math.min(MAX_DEBT_MS, Math.max(0, this.clock() - started - target));
    return completed;
  }
}

export type ExecutionResult = 'open' | 'disconnected' | 'aborted';

/**
 * Runs actions in order. Stops early on disconnect or abort. Pass the same `pacer` for every
 * call on one stream so timer overshoot does not accumulate across frames.
 */
export async function executeFaultActions(
  actions: readonly FaultAction[],
  sink: FaultSink,
  signal: AbortSignal,
  pacer: WaitPacer = new WaitPacer(),
): Promise<ExecutionResult> {
  for (const action of actions) {
    if (signal.aborted) return 'aborted';
    switch (action.kind) {
      case 'wait':
        if (!(await pacer.wait(action.ms, signal))) return 'aborted';
        break;
      case 'write':
        await sink.write(action.bytes, action.injected);
        break;
      case 'annotate':
        sink.annotate(action.faultType, action.message);
        break;
      case 'disconnect':
        sink.disconnect(action.mode, action.faultType);
        return 'disconnected';
    }
  }
  return signal.aborted ? 'aborted' : 'open';
}
