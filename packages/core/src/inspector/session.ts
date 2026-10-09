import type {
  FaultAnnotation,
  FaultSpecJson,
  RequestMeta,
  SessionDetail,
  SessionSource,
  SessionSummary,
} from '@tokenfault/shared';
import type { StreamInspector } from './stream-inspector.js';

/** Request-level facts that the inspector cannot know on its own. */
export interface SessionMeta {
  readonly id: string;
  readonly source: SessionSource;
  readonly startedAt: string;
  readonly method: string;
  /** Path with query values already redacted. */
  readonly path: string;
  readonly scenarioId: string | null;
  readonly faults: readonly FaultSpecJson[];
  readonly request: RequestMeta;
  readonly replayOf: string | null;
}

export function sessionSummary(meta: SessionMeta, inspector: StreamInspector): SessionSummary {
  const snap = inspector.snapshot();
  return {
    id: meta.id,
    source: meta.source,
    startedAt: meta.startedAt,
    method: meta.method,
    path: meta.path,
    status: snap.status,
    outcome: snap.outcome,
    completionSignal: snap.completionSignal,
    termination: snap.termination,
    scenarioId: meta.scenarioId,
    faults: meta.faults,
    request: meta.request,
    metrics: snap.metrics,
    payloadCapture: inspector.capturePayloads,
    truncated: snap.truncated,
    diagnosticCounts: snap.diagnosticCounts,
    replayOf: meta.replayOf,
  };
}

export function sessionDetail(
  meta: SessionMeta,
  inspector: StreamInspector,
  annotations: readonly FaultAnnotation[],
): SessionDetail {
  const snap = inspector.snapshot();
  return {
    ...sessionSummary(meta, inspector),
    responseHeaders: snap.responseHeaders,
    events: [...inspector.events],
    chunks: [...inspector.chunks],
    annotations: [...annotations],
    diagnostics: [...inspector.diagnostics],
    choices: snap.choices,
    droppedEvents: snap.droppedEvents,
    droppedChunks: snap.droppedChunks,
  };
}
