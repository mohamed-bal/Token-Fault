import { sleep } from '../faults/executor.js';
import type { DisconnectMode } from '../faults/schema.js';
import type { ReplayPlan } from './plan.js';

export interface ReplaySink {
  start(status: number, headers: Readonly<Record<string, string>>): void;
  write(bytes: Uint8Array): Promise<void>;
  finish(mode: DisconnectMode): void;
}

/**
 * Executes a replay plan against a sink. Steps are scheduled against absolute
 * offsets from the start, so per-step timer latency does not accumulate into drift.
 */
export async function runReplay(
  plan: ReplayPlan,
  sink: ReplaySink,
  signal: AbortSignal,
  clock: () => number = () => performance.now(),
): Promise<'completed' | 'aborted'> {
  const t0 = clock();
  const waitUntil = (atMs: number): Promise<boolean> => sleep(t0 + atMs - clock(), signal);

  if (!(await waitUntil(plan.headersAtMs))) return 'aborted';
  sink.start(plan.status, plan.headers);
  for (const step of plan.steps) {
    if (!(await waitUntil(step.atMs))) return 'aborted';
    await sink.write(step.bytes);
  }
  if (!(await waitUntil(plan.ending.atMs))) return 'aborted';
  sink.finish(plan.ending.mode);
  return 'completed';
}
