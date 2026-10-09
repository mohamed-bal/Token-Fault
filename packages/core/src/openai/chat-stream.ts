/**
 * OpenAI-compatible Chat Completions streaming interpreter.
 *
 * Interprets the `data` of SSE events produced by `POST /v1/chat/completions`
 * with `stream: true`. Every SSE event maps to exactly one item:
 *
 * - `chunk`: a `chat.completion.chunk` object (choices, deltas, usage)
 * - `done`: the literal `[DONE]` terminator. It belongs to this protocol, not to SSE (DECISIONS.md D-005).
 * - `error`: an in-stream `{ "error": {...} }` payload
 * - `invalid-json`: data that is not JSON
 * - `unrecognized`: JSON that is neither a chunk nor an error
 *
 * Unknown keys are reported, never treated as errors and never dropped: the
 * raw event data remains the source of truth.
 */
import type {
  AssembledChoice,
  AssembledToolCall,
  CompletionSignal,
  DiagnosticCode,
  DiagnosticSeverity,
  StreamErrorPayload,
  TokenUsage,
} from '@tokenfault/shared';

export interface ToolCallDelta {
  readonly index: number;
  readonly id: string | null;
  readonly type: string | null;
  readonly name: string | null;
  readonly arguments: string | null;
}

export interface ChoiceDelta {
  readonly index: number;
  readonly role: string | null;
  readonly content: string | null;
  readonly refusal: string | null;
  readonly toolCalls: readonly ToolCallDelta[];
  readonly finishReason: string | null;
}

export interface ParsedChatChunk {
  readonly id: string | null;
  readonly object: string | null;
  readonly model: string | null;
  readonly created: number | null;
  readonly choices: readonly ChoiceDelta[];
  readonly usage: TokenUsage | null;
  /** Dotted paths of keys the interpreter does not model, e.g. `choices[].delta.reasoning_content`. */
  readonly unknownKeys: readonly string[];
}

export type ChatStreamItem =
  | { readonly kind: 'chunk'; readonly chunk: ParsedChatChunk }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: StreamErrorPayload }
  | { readonly kind: 'invalid-json'; readonly message: string }
  | { readonly kind: 'unrecognized'; readonly topLevelKeys: readonly string[] };

export const DONE_MARKER = '[DONE]';

const KNOWN_TOP = new Set([
  'id',
  'object',
  'created',
  'model',
  'system_fingerprint',
  'choices',
  'usage',
  'service_tier',
  'obfuscation',
]);
const KNOWN_CHOICE = new Set(['index', 'delta', 'finish_reason', 'logprobs']);
const KNOWN_DELTA = new Set(['role', 'content', 'refusal', 'tool_calls', 'function_call']);
const KNOWN_TOOL_CALL = new Set(['index', 'id', 'type', 'function']);
const KNOWN_FUNCTION = new Set(['name', 'arguments']);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function collectUnknown(
  obj: JsonObject,
  known: ReadonlySet<string>,
  prefix: string,
  into: Set<string>,
): void {
  for (const key of Object.keys(obj)) if (!known.has(key)) into.add(`${prefix}${key}`);
}

/** Interprets one SSE `data` payload. Pure function. */
export function interpretChatEventData(data: string): ChatStreamItem {
  if (data === DONE_MARKER) return { kind: 'done' };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    return {
      kind: 'invalid-json',
      message: error instanceof Error ? error.message : 'Invalid JSON',
    };
  }
  if (!isObject(value)) return { kind: 'unrecognized', topLevelKeys: [] };

  if ('error' in value && !('choices' in value)) {
    return { kind: 'error', error: parseErrorPayload(value['error']) };
  }
  const choicesRaw = value['choices'];
  if (!Array.isArray(choicesRaw))
    return { kind: 'unrecognized', topLevelKeys: Object.keys(value).slice(0, 32) };

  const unknown = new Set<string>();
  collectUnknown(value, KNOWN_TOP, '', unknown);

  const choices: ChoiceDelta[] = [];
  for (const [position, rawChoice] of choicesRaw.entries()) {
    if (!isObject(rawChoice)) {
      unknown.add('choices[]<non-object>');
      continue;
    }
    collectUnknown(rawChoice, KNOWN_CHOICE, 'choices[].', unknown);
    const delta = isObject(rawChoice['delta']) ? rawChoice['delta'] : {};
    collectUnknown(delta, KNOWN_DELTA, 'choices[].delta.', unknown);
    const toolCalls: ToolCallDelta[] = [];
    const rawToolCalls = delta['tool_calls'];
    if (Array.isArray(rawToolCalls)) {
      for (const [tcPosition, rawCall] of rawToolCalls.entries()) {
        if (!isObject(rawCall)) continue;
        collectUnknown(rawCall, KNOWN_TOOL_CALL, 'choices[].delta.tool_calls[].', unknown);
        const fn = isObject(rawCall['function']) ? rawCall['function'] : {};
        collectUnknown(fn, KNOWN_FUNCTION, 'choices[].delta.tool_calls[].function.', unknown);
        toolCalls.push({
          index: int(rawCall['index']) ?? tcPosition,
          id: str(rawCall['id']),
          type: str(rawCall['type']),
          name: str(fn['name']),
          arguments: str(fn['arguments']),
        });
      }
    }
    choices.push({
      index: int(rawChoice['index']) ?? position,
      role: str(delta['role']),
      content: str(delta['content']),
      refusal: str(delta['refusal']),
      toolCalls,
      finishReason: str(rawChoice['finish_reason']),
    });
  }

  return {
    kind: 'chunk',
    chunk: {
      id: str(value['id']),
      object: str(value['object']),
      model: str(value['model']),
      created: int(value['created']),
      choices,
      usage: parseUsage(value['usage']),
      unknownKeys: [...unknown],
    },
  };
}

function parseUsage(raw: unknown): TokenUsage | null {
  if (!isObject(raw)) return null;
  const usage: TokenUsage = {
    promptTokens: int(raw['prompt_tokens']),
    completionTokens: int(raw['completion_tokens']),
    totalTokens: int(raw['total_tokens']),
  };
  return usage.promptTokens === null &&
    usage.completionTokens === null &&
    usage.totalTokens === null
    ? null
    : usage;
}

function parseErrorPayload(raw: unknown): StreamErrorPayload {
  if (isObject(raw)) {
    return {
      message: str(raw['message']) ?? JSON.stringify(raw).slice(0, 500),
      type: str(raw['type']),
      code: str(raw['code']) ?? (typeof raw['code'] === 'number' ? String(raw['code']) : null),
    };
  }
  return {
    message: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null),
    type: null,
    code: null,
  };
}

// ---------------------------------------------------------------------------
// Accumulator: assembles a full response and checks protocol invariants.
// ---------------------------------------------------------------------------

export interface ChatDiagnostic {
  readonly code: Extract<DiagnosticCode, `chat-${string}`>;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

export interface ChatAccumulatorOptions {
  /** Retain content and tool arguments. When `false`, only lengths are kept. Default `true`. */
  readonly retainPayloads?: boolean;
  /** Upper bound on retained characters across all choices. Default 4 Mi chars. */
  readonly maxRetainedChars?: number;
}

interface MutableToolCall {
  index: number;
  id: string | null;
  type: string | null;
  name: string | null;
  arguments: string;
  argumentsLength: number;
  fragmentCount: number;
}

interface MutableChoice {
  index: number;
  role: string | null;
  content: string;
  contentLength: number;
  refusal: string | null;
  toolCalls: Map<number, MutableToolCall>;
  finishReason: string | null;
}

export interface ChatStreamVerdict {
  readonly outcome: 'completed' | 'incomplete' | 'stream-error';
  readonly completionSignal: CompletionSignal;
}

export class ChatStreamAccumulator {
  private readonly retainPayloads: boolean;
  private readonly maxRetainedChars: number;
  private readonly choices = new Map<number, MutableChoice>();
  private readonly reportedUnknown = new Set<string>();
  private retainedChars = 0;
  private doneSeen = false;
  private errorSeen = false;
  private usage: TokenUsage | null = null;
  /** True once the retained-character budget was exhausted. */
  retentionTruncated = false;

  constructor(options: ChatAccumulatorOptions = {}) {
    this.retainPayloads = options.retainPayloads ?? true;
    this.maxRetainedChars = options.maxRetainedChars ?? 4 * 1024 * 1024;
  }

  get sawDone(): boolean {
    return this.doneSeen;
  }

  get lastUsage(): TokenUsage | null {
    return this.usage;
  }

  /** Applies one interpreted item and returns protocol diagnostics it triggered. */
  apply(item: ChatStreamItem): ChatDiagnostic[] {
    const diagnostics: ChatDiagnostic[] = [];
    if (this.doneSeen) {
      diagnostics.push({
        code: 'chat-event-after-done',
        severity: 'warning',
        message: `Received a "${item.kind}" event after the [DONE] terminator.`,
      });
    }
    switch (item.kind) {
      case 'done':
        this.doneSeen = true;
        break;
      case 'error':
        this.errorSeen = true;
        diagnostics.push({
          code: 'chat-stream-error',
          severity: 'error',
          message: `In-stream error${item.error.type ? ` (${item.error.type})` : ''}: ${item.error.message}`,
        });
        break;
      case 'invalid-json':
        diagnostics.push({
          code: 'chat-invalid-json',
          severity: 'error',
          message: `Event data is not valid JSON: ${item.message}`,
        });
        break;
      case 'unrecognized':
        diagnostics.push({
          code: 'chat-unrecognized-payload',
          severity: 'warning',
          message: `JSON payload is not a chat.completion.chunk (keys: ${item.topLevelKeys.join(', ') || 'none'}).`,
        });
        break;
      case 'chunk':
        this.applyChunk(item.chunk, diagnostics);
        break;
    }
    return diagnostics;
  }

  private applyChunk(chunk: ParsedChatChunk, diagnostics: ChatDiagnostic[]): void {
    const fresh = chunk.unknownKeys.filter((key) => !this.reportedUnknown.has(key));
    if (fresh.length > 0) {
      for (const key of fresh) this.reportedUnknown.add(key);
      diagnostics.push({
        code: 'chat-unknown-keys',
        severity: 'info',
        message: `Keys not modelled by the interpreter (kept in raw data): ${fresh.join(', ')}`,
      });
    }
    if (chunk.usage) this.usage = chunk.usage;

    for (const delta of chunk.choices) {
      let choice = this.choices.get(delta.index);
      if (!choice) {
        choice = {
          index: delta.index,
          role: null,
          content: '',
          contentLength: 0,
          refusal: null,
          toolCalls: new Map(),
          finishReason: null,
        };
        this.choices.set(delta.index, choice);
      }
      const carriesDelta =
        (delta.content !== null && delta.content.length > 0) ||
        delta.toolCalls.length > 0 ||
        (delta.refusal !== null && delta.refusal.length > 0);
      if (choice.finishReason !== null && carriesDelta) {
        diagnostics.push({
          code: 'chat-delta-after-finish',
          severity: 'warning',
          message: `Choice ${delta.index} received a delta after finish_reason "${choice.finishReason}".`,
        });
      }
      if (delta.role !== null) choice.role = delta.role;
      if (delta.content !== null) {
        choice.contentLength += delta.content.length;
        choice.content += this.retain(delta.content);
      }
      if (delta.refusal !== null)
        choice.refusal = (choice.refusal ?? '') + this.retain(delta.refusal);
      for (const tc of delta.toolCalls) {
        let call = choice.toolCalls.get(tc.index);
        if (!call) {
          if (tc.id === null && tc.name === null) {
            diagnostics.push({
              code: 'chat-tool-call-missing-header',
              severity: 'warning',
              message: `Tool call ${tc.index} on choice ${delta.index} started without an id or function name.`,
            });
          }
          call = {
            index: tc.index,
            id: null,
            type: null,
            name: null,
            arguments: '',
            argumentsLength: 0,
            fragmentCount: 0,
          };
          choice.toolCalls.set(tc.index, call);
        }
        if (tc.id !== null) call.id = tc.id;
        if (tc.type !== null) call.type = tc.type;
        // Most providers send the name once; some repeat it on every fragment and a few split it.
        if (tc.name !== null && tc.name !== call.name) call.name = (call.name ?? '') + tc.name;
        if (tc.arguments !== null) {
          call.argumentsLength += tc.arguments.length;
          call.arguments += this.retain(tc.arguments);
          call.fragmentCount += 1;
        }
      }
      if (delta.finishReason !== null) choice.finishReason = delta.finishReason;
    }
  }

  private retain(text: string): string {
    if (!this.retainPayloads) return '';
    if (this.retainedChars + text.length > this.maxRetainedChars) {
      this.retentionTruncated = true;
      const room = Math.max(0, this.maxRetainedChars - this.retainedChars);
      this.retainedChars += room;
      return text.slice(0, room);
    }
    this.retainedChars += text.length;
    return text;
  }

  /**
   * Computes the protocol verdict.
   * @param cleanEof `true` when the transport ended normally (not reset, aborted or timed out).
   */
  verdict(cleanEof: boolean): ChatStreamVerdict {
    if (this.errorSeen) return { outcome: 'stream-error', completionSignal: null };
    if (this.doneSeen) return { outcome: 'completed', completionSignal: 'done-marker' };
    const all = [...this.choices.values()];
    if (cleanEof && all.length > 0 && all.every((c) => c.finishReason !== null)) {
      return { outcome: 'completed', completionSignal: 'finish-reason' };
    }
    return { outcome: 'incomplete', completionSignal: null };
  }

  /** End-of-stream diagnostics (missing terminator, invalid tool arguments). */
  finalize(cleanEof: boolean): ChatDiagnostic[] {
    const diagnostics: ChatDiagnostic[] = [];
    const v = this.verdict(cleanEof);
    if (!this.doneSeen && !this.errorSeen) {
      diagnostics.push(
        v.outcome === 'completed'
          ? {
              code: 'chat-missing-terminator',
              severity: 'info',
              message: 'Stream ended without [DONE], but every choice reported a finish_reason.',
            }
          : {
              code: 'chat-missing-terminator',
              severity: 'error',
              message:
                'Stream ended without [DONE] and without a finish_reason: the response is incomplete.',
            },
      );
    }
    for (const choice of this.assemble()) {
      for (const call of choice.toolCalls) {
        if (call.argumentsValidJson === false) {
          diagnostics.push({
            code: 'chat-tool-arguments-invalid-json',
            severity: 'error',
            message: `Tool call ${call.index} (${call.name ?? 'unnamed'}) on choice ${choice.index} has arguments that are not valid JSON after assembly.`,
          });
        }
      }
    }
    return diagnostics;
  }

  assemble(): AssembledChoice[] {
    return [...this.choices.values()]
      .sort((a, b) => a.index - b.index)
      .map((choice) => ({
        index: choice.index,
        role: choice.role,
        content: this.retainPayloads ? choice.content : null,
        contentLength: choice.contentLength,
        refusal: this.retainPayloads ? choice.refusal : null,
        finishReason: choice.finishReason,
        toolCalls: [...choice.toolCalls.values()]
          .sort((a, b) => a.index - b.index)
          .map((call): AssembledToolCall => ({
            index: call.index,
            id: call.id,
            type: call.type,
            name: call.name,
            arguments: this.retainPayloads ? call.arguments : null,
            argumentsLength: call.argumentsLength,
            argumentsValidJson:
              this.retainPayloads && !this.retentionTruncated && choice.finishReason !== null
                ? isValidJson(call.arguments)
                : null,
            fragmentCount: call.fragmentCount,
          })),
      }));
  }
}

function isValidJson(text: string): boolean {
  if (text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
