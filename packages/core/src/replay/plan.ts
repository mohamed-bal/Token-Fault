/**
 * Replay planning: converts a recording into a timed sequence of byte writes.
 *
 * Replay re-emits a recorded response timeline without contacting any model.
 * It does not regenerate a model response: identical replays only mean the
 * recorded bytes are re-sent with recorded (or transformed) timing.
 *
 * Two modes:
 * - `chunks`: byte-exact. Re-sends the original network chunks. Requires a
 *   recording with payloads and a complete chunk capture.
 * - `events`: re-serialises recorded SSE events. Works for payload-free
 *   recordings, which contain redacted skeletons. Original chunk boundaries are
 *   not reproduced.
 */
import type { ReplayTiming } from '@tokenfault/shared';
import { base64ToBytes } from '../util/base64.js';
import { serializeSseEvent } from '../sse/encoder.js';
import type { DisconnectMode } from '../faults/schema.js';
import type { Recording } from '../recording/schema.js';

export interface ReplayStep {
  readonly atMs: number;
  readonly bytes: Uint8Array;
}

export interface ReplayPlan {
  readonly mode: 'chunks' | 'events';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly headersAtMs: number;
  readonly steps: readonly ReplayStep[];
  /** How the transport ends after the last step. */
  readonly ending: { readonly atMs: number; readonly mode: DisconnectMode };
}

const enc = new TextEncoder();

/** Headers re-emitted on replay. Length/encoding headers are recomputed by the transport. */
const REPLAY_HEADER_ALLOWLIST = new Set([
  'content-type',
  'cache-control',
  'retry-after',
  'x-request-id',
  'request-id',
]);

export function validateTiming(timing: ReplayTiming): string | null {
  if (
    timing.kind === 'scaled' &&
    !(Number.isFinite(timing.factor) && timing.factor >= 0.01 && timing.factor <= 100)
  ) {
    return 'scaled timing factor must be between 0.01 and 100';
  }
  if (
    timing.kind === 'fixed' &&
    !(Number.isInteger(timing.gapMs) && timing.gapMs >= 0 && timing.gapMs <= 60_000)
  ) {
    return 'fixed timing gapMs must be an integer between 0 and 60000';
  }
  return null;
}

export function createReplayPlan(
  recording: Recording,
  timing: ReplayTiming = { kind: 'original' },
): ReplayPlan {
  const timingError = validateTiming(timing);
  if (timingError) throw new RangeError(timingError);
  const session = recording.session;
  const canReplayChunks = recording.payloads.included && recording.chunks.length > 0;
  const mode: ReplayPlan['mode'] = canReplayChunks ? 'chunks' : 'events';

  const raw: { atMs: number; bytes: Uint8Array }[] =
    mode === 'chunks'
      ? recording.chunks.map((c) => ({ atMs: c.atMs, bytes: base64ToBytes(c.dataBase64) }))
      : recording.events.map((e) => ({
          atMs: e.atMs,
          bytes: enc.encode(
            serializeSseEvent({
              data: e.data,
              ...(e.event !== 'message' ? { event: e.event } : {}),
              ...(e.id !== null ? { id: e.id } : {}),
              ...(e.retry !== null ? { retry: e.retry } : {}),
            }),
          ),
        }));

  const headersAt = session.metrics.headersMs ?? 0;
  const endAt = session.termination?.atMs ?? raw.at(-1)?.atMs ?? headersAt;
  const transform = timeTransform(timing, headersAt);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(session.responseHeaders)) {
    if (REPLAY_HEADER_ALLOWLIST.has(name)) headers[name] = value;
  }
  if (mode === 'events') headers['content-type'] = 'text/event-stream; charset=utf-8';

  const steps = raw.map((step, i) => ({ atMs: transform(step.atMs, i + 1), bytes: step.bytes }));
  const lastStepAt = steps.at(-1)?.atMs ?? transform(headersAt, 0);
  return {
    mode,
    status: session.status ?? 200,
    headers,
    headersAtMs: transform(headersAt, 0),
    steps,
    ending: {
      atMs: Math.max(
        lastStepAt,
        timing.kind === 'fixed' ? lastStepAt : transform(endAt, steps.length + 1),
      ),
      mode: endingMode(recording),
    },
  };
}

function timeTransform(
  timing: ReplayTiming,
  headersAt: number,
): (atMs: number, index: number) => number {
  switch (timing.kind) {
    case 'original':
      return (atMs) => atMs;
    case 'scaled':
      return (atMs) => atMs / timing.factor;
    case 'fixed':
      return (_atMs, index) =>
        index === 0 ? Math.min(headersAt, timing.gapMs) : index * timing.gapMs;
  }
}

function endingMode(recording: Recording): DisconnectMode {
  const termination = recording.session.termination;
  if (!termination) return 'end';
  switch (termination.kind) {
    case 'eof':
    case 'replay-end':
      return 'end';
    case 'fault-disconnect': {
      const match = /mode=(reset|destroy|end)/.exec(termination.detail ?? '');
      return (match?.[1] as DisconnectMode | undefined) ?? 'reset';
    }
    case 'upstream-reset':
      return 'reset';
    case 'client-abort':
    case 'upstream-timeout':
    case 'upstream-unreachable':
    case 'proxy-error':
      return 'destroy';
  }
}
