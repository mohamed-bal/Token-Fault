import { z } from 'zod';
import { REDACTED, describeError } from '@tokenfault/shared';
import type { CapturedEvent, SessionDetail } from '@tokenfault/shared';
import { DONE_MARKER } from '../openai/chat-stream.js';
import { utf8ByteLength } from '../sse/decoder.js';
import { RecordingSchema } from './schema.js';
import type { Recording } from './schema.js';

/**
 * Keys whose string values are structural (enums, identifiers, model names)
 * and are kept in payload-free recordings. Every other string value is
 * replaced with the redaction marker.
 */
const STRUCTURAL_KEYS = new Set([
  'object',
  'role',
  'finish_reason',
  'type',
  'model',
  'id',
  'name',
  'system_fingerprint',
  'service_tier',
  'code',
]);

/**
 * Produces a payload-free skeleton of an event's data: the JSON structure,
 * numbers, booleans and structural string values are kept, and all other
 * strings (content, tool arguments, error messages, ...) are redacted.
 * Non-JSON data other than `[DONE]` is replaced entirely.
 */
export function redactEventData(data: string): string {
  if (data === DONE_MARKER) return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return REDACTED;
  }
  return JSON.stringify(redactValue(parsed, null));
}

function redactValue(value: unknown, key: string | null): unknown {
  if (typeof value === 'string') return key !== null && STRUCTURAL_KEYS.has(key) ? value : REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, null));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}

/** Rebuilds a structural skeleton from the interpretation when the raw data was never captured. */
function skeletonFromInterpretation(event: CapturedEvent): string {
  const i = event.interpretation;
  switch (i.kind) {
    case 'done':
      return DONE_MARKER;
    case 'error':
      return JSON.stringify({
        error: { message: REDACTED, type: i.error?.type ?? null, code: i.error?.code ?? null },
      });
    case 'invalid-json':
    case 'unrecognized':
      return REDACTED;
    case 'chunk': {
      const indices = new Set<number>([
        ...i.finishReasons.map((f) => f.choiceIndex),
        ...i.toolCalls.map((t) => t.choiceIndex),
      ]);
      if (indices.size === 0 && (i.contentLength > 0 || i.roles.length > 0)) indices.add(0);
      const choices = [...indices]
        .sort((a, b) => a - b)
        .map((index) => {
          const delta: Record<string, unknown> = {};
          if (index === 0 && i.roles[0] !== undefined) delta['role'] = i.roles[0];
          if (index === 0 && i.contentLength > 0) delta['content'] = REDACTED;
          const calls = i.toolCalls.filter((t) => t.choiceIndex === index);
          if (calls.length > 0) {
            delta['tool_calls'] = calls.map((t) => ({
              index: t.index,
              ...(t.id !== null ? { id: t.id } : {}),
              ...(t.type !== null ? { type: t.type } : {}),
              function: {
                ...(t.name !== null ? { name: t.name } : {}),
                arguments: t.argumentsFragmentLength > 0 ? REDACTED : '',
              },
            }));
          }
          return {
            index,
            delta,
            finish_reason: i.finishReasons.find((f) => f.choiceIndex === index)?.reason ?? null,
          };
        });
      const usage = i.usage
        ? {
            prompt_tokens: i.usage.promptTokens,
            completion_tokens: i.usage.completionTokens,
            total_tokens: i.usage.totalTokens,
          }
        : undefined;
      return JSON.stringify({
        object: 'chat.completion.chunk',
        choices,
        ...(usage ? { usage } : {}),
      });
    }
  }
}

export interface CreateRecordingOptions {
  /** Include original payloads (event data and raw chunks). Default `false`. */
  readonly includePayloads?: boolean;
  readonly toolVersion: string;
  readonly seed: number | null;
  /** Clock for `recordedAt` (injectable for tests). */
  readonly now?: () => Date;
}

/**
 * Builds a validated recording from a session. The result is passed through
 * the same schema used when loading, so every exported recording can be loaded again.
 */
export function createRecording(
  session: SessionDetail,
  options: CreateRecordingOptions,
): Recording {
  const includePayloads = (options.includePayloads ?? false) && session.payloadCapture;
  const chunksComplete =
    includePayloads &&
    session.droppedChunks === 0 &&
    session.chunks.length === session.metrics.chunkCount &&
    session.chunks.every((c) => c.dataBase64 !== null);

  const doc = {
    format: 'tokenfault-recording',
    schemaVersion: 1,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
    tool: { name: 'tokenfault', version: options.toolVersion },
    session: {
      id: session.id,
      source: session.source,
      method: session.method,
      path: session.path,
      status: session.status,
      responseHeaders: session.responseHeaders,
      request: session.request,
      outcome: session.outcome,
      completionSignal: session.completionSignal,
      termination: session.termination,
      scenarioId: session.scenarioId,
      faults: session.faults,
      seed: options.seed,
      metrics: session.metrics,
    },
    payloads: { included: includePayloads },
    events: session.events.map((e) => {
      const data =
        includePayloads && e.data !== null
          ? e.data
          : e.data !== null
            ? redactEventData(e.data)
            : skeletonFromInterpretation(e);
      return {
        seq: e.seq,
        atMs: e.atMs,
        event: e.event,
        id: e.id,
        retry: e.retry,
        data,
        dataByteLength: e.dataByteLength,
        rawByteLength: e.rawByteLength,
        kind: e.interpretation.kind,
      };
    }),
    chunks: chunksComplete
      ? session.chunks.map((c) => ({
          seq: c.seq,
          atMs: c.atMs,
          byteLength: c.byteLength,
          dataBase64: c.dataBase64 ?? '',
        }))
      : [],
    annotations: session.annotations.slice(0, 1_000),
  };
  return RecordingSchema.parse(doc);
}

export type RecordingParseResult =
  | { readonly ok: true; readonly recording: Recording }
  | { readonly ok: false; readonly error: string };

/**
 * Parses an untrusted recording document. Enforces a byte-size limit before
 * parsing, then validates strictly. Never throws.
 */
export function parseRecording(text: string, maxBytes: number): RecordingParseResult {
  const size = utf8ByteLength(text);
  if (size > maxBytes)
    return { ok: false, error: `Recording is ${size} bytes; the limit is ${maxBytes} bytes.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Recording is not valid JSON: ${describeError(error)}` };
  }
  return validateRecording(raw);
}

/** Validates an already-parsed recording object (e.g. from an HTTP JSON body). */
export function validateRecording(raw: unknown): RecordingParseResult {
  if (typeof raw === 'object' && raw !== null && 'schemaVersion' in raw) {
    const version = raw.schemaVersion;
    if (version !== 1)
      return {
        ok: false,
        error: `Unsupported recording schemaVersion ${JSON.stringify(version)}; this build supports 1.`,
      };
  }
  const result = RecordingSchema.safeParse(raw);
  if (!result.success)
    return { ok: false, error: `Invalid recording:\n${z.prettifyError(result.error)}` };
  return { ok: true, recording: result.data };
}

export function serializeRecording(recording: Recording): string {
  return `${JSON.stringify(recording, null, 2)}\n`;
}
