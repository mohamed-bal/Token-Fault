/**
 * Recording format v1 (DECISIONS.md D-012).
 *
 * A recording is a single JSON document that captures one session's response
 * timeline. It is designed to be:
 *
 * - Safe by default: request headers and bodies are never included. Response
 *   payloads are included only when explicitly requested, otherwise the
 *   event structure is kept with free text replaced by a redaction marker.
 * - Validated: strict zod schema, bounded arrays and strings, monotonic
 *   timestamps. Unknown keys are rejected.
 * - Versioned: `schemaVersion` gates the parser. Future versions get their
 *   own schema and an explicit migration.
 */
import { z } from 'zod';
import { FaultSpecSchema } from '../faults/schema.js';

export const RECORDING_FORMAT = 'tokenfault-recording';
export const RECORDING_SCHEMA_VERSION = 1;
export const MAX_RECORDED_EVENTS = 100_000;
export const MAX_RECORDED_CHUNKS = 200_000;
export const MAX_RECORDED_ANNOTATIONS = 1_000;

const ms = z
  .number()
  .finite()
  .min(0)
  .max(24 * 60 * 60 * 1000);
const nullableMs = ms.nullable();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().max(2_000);

const TerminationSchema = z.strictObject({
  kind: z.enum([
    'eof',
    'client-abort',
    'upstream-reset',
    'upstream-timeout',
    'upstream-unreachable',
    'fault-disconnect',
    'proxy-error',
    'replay-end',
  ]),
  atMs: ms,
  detail: shortText.nullable(),
});

const UsageSchema = z.strictObject({
  promptTokens: count.nullable(),
  completionTokens: count.nullable(),
  totalTokens: count.nullable(),
});

const GapStatsSchema = z.strictObject({
  count,
  minMs: ms,
  maxMs: ms,
  meanMs: ms,
  p50Ms: ms,
  p95Ms: ms,
  p99Ms: ms,
});

const MetricsSchema = z.strictObject({
  headersMs: nullableMs,
  firstByteMs: nullableMs,
  firstEventMs: nullableMs,
  firstContentMs: nullableMs,
  durationMs: nullableMs,
  eventCount: count,
  chunkCount: count,
  byteCount: count,
  contentDeltaCount: count,
  toolCallDeltaCount: count,
  eventGaps: GapStatsSchema.nullable(),
  usage: UsageSchema.nullable(),
});

export const RecordedEventSchema = z.strictObject({
  seq: count,
  atMs: ms,
  event: z.string().max(256),
  id: z.string().max(1_024).nullable(),
  retry: count.nullable(),
  /** Event data: original when payloads are included, a redacted skeleton otherwise. */
  data: z.string().max(16 * 1024 * 1024),
  dataByteLength: count,
  rawByteLength: count,
  kind: z.enum(['chunk', 'done', 'error', 'invalid-json', 'unrecognized']),
});

export const RecordedChunkSchema = z.strictObject({
  seq: count,
  atMs: ms,
  byteLength: count,
  dataBase64: z.string().max(64 * 1024 * 1024),
});

export const RecordedAnnotationSchema = z.strictObject({
  atMs: ms,
  faultType: z.string().max(64),
  message: shortText,
  afterEvents: count.nullable(),
});

export const RecordingSchema = z
  .strictObject({
    format: z.literal(RECORDING_FORMAT),
    schemaVersion: z.literal(RECORDING_SCHEMA_VERSION),
    recordedAt: z.iso.datetime(),
    tool: z.strictObject({ name: z.literal('tokenfault'), version: z.string().max(64) }),
    session: z.strictObject({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      source: z.enum(['proxy', 'replay']),
      method: z.string().regex(/^[A-Z]{1,16}$/),
      path: z.string().max(2_048),
      status: z.number().int().min(100).max(599).nullable(),
      responseHeaders: z.record(z.string().max(128), z.string().max(4_096)),
      request: z.strictObject({
        model: z.string().max(256).nullable(),
        stream: z.boolean().nullable(),
        messageCount: count.nullable(),
        toolCount: count.nullable(),
        bodyBytes: count,
      }),
      outcome: z.enum([
        'pending',
        'completed',
        'incomplete',
        'stream-error',
        'http-error',
        'non-stream',
      ]),
      completionSignal: z.enum(['done-marker', 'finish-reason']).nullable(),
      termination: TerminationSchema.nullable(),
      scenarioId: z.string().max(128).nullable(),
      faults: z.array(FaultSpecSchema).max(16),
      seed: z.number().int().min(0).max(0xffffffff).nullable(),
      metrics: MetricsSchema,
    }),
    payloads: z.strictObject({ included: z.boolean() }),
    events: z.array(RecordedEventSchema).max(MAX_RECORDED_EVENTS),
    chunks: z.array(RecordedChunkSchema).max(MAX_RECORDED_CHUNKS),
    annotations: z.array(RecordedAnnotationSchema).max(MAX_RECORDED_ANNOTATIONS),
  })
  .superRefine((rec, ctx) => {
    if (Object.keys(rec.session.responseHeaders).length > 64) {
      ctx.addIssue({
        code: 'custom',
        path: ['session', 'responseHeaders'],
        message: 'too many headers (max 64)',
      });
    }
    if (!rec.payloads.included && rec.chunks.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['chunks'],
        message: 'chunks must be empty when payloads are not included',
      });
    }
    checkMonotonic(rec.events, 'events', ctx);
    checkMonotonic(rec.chunks, 'chunks', ctx);
  });

function checkMonotonic(
  items: readonly { seq: number; atMs: number }[],
  path: string,
  ctx: z.RefinementCtx,
): void {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!;
    const cur = items[i]!;
    if (cur.seq <= prev.seq) {
      ctx.addIssue({
        code: 'custom',
        path: [path, i, 'seq'],
        message: 'sequence numbers must be strictly increasing',
      });
      return;
    }
    if (cur.atMs < prev.atMs) {
      ctx.addIssue({
        code: 'custom',
        path: [path, i, 'atMs'],
        message: 'timestamps must be non-decreasing',
      });
      return;
    }
  }
}

export type Recording = z.infer<typeof RecordingSchema>;
export type RecordedEvent = z.infer<typeof RecordedEventSchema>;
export type RecordedChunk = z.infer<typeof RecordedChunkSchema>;
