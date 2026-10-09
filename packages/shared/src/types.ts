/**
 * Wire contracts shared by the TokenFault server, CLI, testing helpers and Studio.
 *
 * These are plain JSON-serialisable shapes. All timestamps named `...Ms`
 * are offsets in milliseconds from the start of the request (monotonic clock),
 * not wall-clock times. Wall-clock times are ISO-8601 strings.
 */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticCode =
  // SSE framing level
  | 'sse-invalid-utf8'
  | 'sse-event-too-large'
  | 'sse-unknown-field'
  | 'sse-invalid-retry'
  | 'sse-id-contains-null'
  | 'sse-empty-event'
  | 'sse-truncated-event'
  | 'sse-bom'
  // OpenAI chat-completions interpretation level
  | 'chat-invalid-json'
  | 'chat-unrecognized-payload'
  | 'chat-unknown-keys'
  | 'chat-event-after-done'
  | 'chat-delta-after-finish'
  | 'chat-missing-terminator'
  | 'chat-tool-arguments-invalid-json'
  | 'chat-tool-call-missing-header'
  | 'chat-stream-error'
  // Transport level
  | 'transport-non-sse-content-type'
  | 'transport-compressed-body'
  | 'transport-capture-truncated';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  /** Offset (ms since request start) at which the condition was detected, if known. */
  readonly atMs: number | null;
  /** Sequence number of the related SSE event, if any. */
  readonly eventSeq: number | null;
}

// ---------------------------------------------------------------------------
// Captured stream data
// ---------------------------------------------------------------------------

/** A network-level chunk as delivered to the client (one read/write, not one token and not one event). */
export interface CapturedChunk {
  readonly seq: number;
  readonly atMs: number;
  readonly byteLength: number;
  /** Raw chunk bytes, base64-encoded. `null` when payload capture is disabled or the capture budget is spent. */
  readonly dataBase64: string | null;
}

export type InterpretedKind =
  | 'chunk' // a chat.completion.chunk payload
  | 'done' // the provider-specific `[DONE]` terminator
  | 'error' // an in-stream error payload
  | 'invalid-json' // data that is not valid JSON
  | 'unrecognized'; // valid JSON that does not look like a chat completion chunk

export interface ToolCallDeltaSummary {
  readonly choiceIndex: number;
  readonly index: number;
  readonly id: string | null;
  readonly type: string | null;
  readonly name: string | null;
  /** Arguments fragment. `null` when payload capture is disabled. */
  readonly argumentsFragment: string | null;
  readonly argumentsFragmentLength: number;
}

export interface TokenUsage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export interface StreamErrorPayload {
  readonly message: string;
  readonly type: string | null;
  readonly code: string | null;
}

export interface EventInterpretation {
  readonly kind: InterpretedKind;
  /** Concatenated `delta.content` across choices in this event. `null` when redacted or absent. */
  readonly content: string | null;
  readonly contentLength: number;
  readonly roles: readonly string[];
  readonly finishReasons: readonly { readonly choiceIndex: number; readonly reason: string }[];
  readonly toolCalls: readonly ToolCallDeltaSummary[];
  readonly usage: TokenUsage | null;
  readonly error: StreamErrorPayload | null;
  /** Keys not recognised by the interpreter. They are preserved in the raw data, never dropped silently. */
  readonly unknownKeys: readonly string[];
}

export interface CapturedEvent {
  readonly seq: number;
  readonly atMs: number;
  /** SSE event type (`message` when the stream did not set one). */
  readonly event: string;
  /** The `id` field set in this event's block, if any. */
  readonly id: string | null;
  readonly retry: number | null;
  /** The event's `data` field. `null` when payload capture is disabled or the capture budget is spent. */
  readonly data: string | null;
  readonly dataByteLength: number;
  /** Raw byte length of the event block on the wire, including field names and line terminators. */
  readonly rawByteLength: number;
  readonly interpretation: EventInterpretation;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface GapStats {
  readonly count: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

/**
 * Measured stream metrics. Every field is either measured from real I/O
 * timestamps or reported by the API (`usage`). Nothing is estimated.
 * SSE events and content deltas are *not* tokens.
 */
export interface StreamMetrics {
  /** Response status line + headers received. */
  readonly headersMs: number | null;
  /** First response body byte received. */
  readonly firstByteMs: number | null;
  /** First complete SSE event parsed. */
  readonly firstEventMs: number | null;
  /** First event carrying a non-empty content delta or tool-call delta. */
  readonly firstContentMs: number | null;
  /** Request start to end of response (or failure). */
  readonly durationMs: number | null;
  readonly eventCount: number;
  readonly chunkCount: number;
  readonly byteCount: number;
  readonly contentDeltaCount: number;
  readonly toolCallDeltaCount: number;
  /** Gaps between consecutive SSE events. `null` with fewer than two events. */
  readonly eventGaps: GapStats | null;
  /** Token usage exactly as reported by the API, or `null` when the API did not report it. */
  readonly usage: TokenUsage | null;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Protocol-level verdict on the response as seen by the client. */
export type StreamOutcome =
  'pending' | 'completed' | 'incomplete' | 'stream-error' | 'http-error' | 'non-stream';

/** How the transport ended. Independent from the outcome. */
export type TerminationKind =
  | 'eof'
  | 'client-abort'
  | 'upstream-reset'
  | 'upstream-timeout'
  | 'upstream-unreachable'
  | 'fault-disconnect'
  | 'proxy-error'
  | 'replay-end';

export interface Termination {
  readonly kind: TerminationKind;
  readonly atMs: number;
  /** Secret-scrubbed detail message. */
  readonly detail: string | null;
}

/** Which signal made a stream count as complete. */
export type CompletionSignal = 'done-marker' | 'finish-reason' | null;

// ---------------------------------------------------------------------------
// Assembled response
// ---------------------------------------------------------------------------

export interface AssembledToolCall {
  readonly index: number;
  readonly id: string | null;
  readonly type: string | null;
  readonly name: string | null;
  /** Full concatenated arguments. `null` when redacted. */
  readonly arguments: string | null;
  readonly argumentsLength: number;
  /** Whether the concatenated arguments parse as JSON. `null` when the stream did not finish or arguments are redacted. */
  readonly argumentsValidJson: boolean | null;
  readonly fragmentCount: number;
}

export interface AssembledChoice {
  readonly index: number;
  readonly role: string | null;
  /** Full concatenated content. `null` when redacted. */
  readonly content: string | null;
  readonly contentLength: number;
  readonly refusal: string | null;
  readonly toolCalls: readonly AssembledToolCall[];
  readonly finishReason: string | null;
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/** JSON shape of a fault specification. The canonical schema lives in `@tokenfault/core`. */
export interface FaultSpecJson {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface FaultAnnotation {
  readonly atMs: number;
  readonly faultType: string;
  readonly message: string;
  /** Number of events delivered before the fault took effect. */
  readonly afterEvents: number | null;
}

export type FaultParamKind = 'integer' | 'enum' | 'boolean';

export interface FaultParamDescriptor {
  readonly name: string;
  readonly kind: FaultParamKind;
  readonly description: string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
  readonly optional?: boolean;
  readonly unit?: 'ms' | 'events' | 'bytes' | 'seconds' | 'chars';
}

export type FaultTarget = 'proxy' | 'mock';

export interface FaultTypeDescriptor {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly phase: 'pre-response' | 'stream';
  readonly appliesTo: readonly FaultTarget[];
  readonly params: readonly FaultParamDescriptor[];
}

export interface ScenarioDescriptor {
  readonly id: string;
  readonly letter: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly appliesTo: readonly FaultTarget[];
  readonly faults: readonly FaultSpecJson[];
  readonly seed: number;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionSource = 'proxy' | 'replay';

/** Non-sensitive facts about the request. Prompt content is never captured. */
export interface RequestMeta {
  readonly model: string | null;
  readonly stream: boolean | null;
  readonly messageCount: number | null;
  readonly toolCount: number | null;
  readonly bodyBytes: number;
}

export interface SessionSummary {
  readonly id: string;
  readonly source: SessionSource;
  /** Wall-clock start time (ISO-8601). */
  readonly startedAt: string;
  readonly method: string;
  /** Request path with query values redacted. */
  readonly path: string;
  readonly status: number | null;
  readonly outcome: StreamOutcome;
  readonly completionSignal: CompletionSignal;
  readonly termination: Termination | null;
  readonly scenarioId: string | null;
  readonly faults: readonly FaultSpecJson[];
  readonly request: RequestMeta;
  readonly metrics: StreamMetrics;
  readonly payloadCapture: boolean;
  /** True if any capture limit was hit and some data was not stored. */
  readonly truncated: boolean;
  readonly diagnosticCounts: Readonly<Record<DiagnosticSeverity, number>>;
  /** For replay sessions: the session id or recording the replay came from. */
  readonly replayOf: string | null;
}

export interface SessionDetail extends SessionSummary {
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly events: readonly CapturedEvent[];
  readonly chunks: readonly CapturedChunk[];
  readonly annotations: readonly FaultAnnotation[];
  readonly diagnostics: readonly Diagnostic[];
  readonly choices: readonly AssembledChoice[];
  /** Number of events that were observed but not stored because of capture limits. */
  readonly droppedEvents: number;
  readonly droppedChunks: number;
}

// ---------------------------------------------------------------------------
// Control API
// ---------------------------------------------------------------------------

export interface ServerInfo {
  readonly name: 'tokenfault';
  readonly version: string;
  /** Upstream target without credentials, query or fragment. */
  readonly target: string;
  readonly payloadCapture: boolean;
  readonly recording: { readonly enabled: boolean; readonly includePayloads: boolean };
  readonly activeFaults: ActiveFaults | null;
  readonly limits: {
    readonly maxSessions: number;
    readonly maxEventsPerSession: number;
    readonly maxCapturedBytesPerSession: number;
  };
}

export interface ActiveFaults {
  readonly scenarioId: string | null;
  readonly faults: readonly FaultSpecJson[];
  readonly seed: number;
}

export interface ProbeRequest {
  readonly prompt?: string;
  readonly scenarioId?: string;
  readonly withTools?: boolean;
}

export interface ProbeResponse {
  readonly sessionId: string | null;
  readonly status: number | null;
  readonly error: string | null;
}

export type ReplayTiming =
  | { readonly kind: 'original' }
  | { readonly kind: 'scaled'; readonly factor: number }
  | { readonly kind: 'fixed'; readonly gapMs: number };

export interface ReplayRequest {
  /** Replay a session held in memory... */
  readonly sessionId?: string;
  /** ...or a recording document (validated server-side). */
  readonly recording?: unknown;
  readonly timing?: ReplayTiming;
}

export interface ReplayResponse {
  readonly sessionId: string;
  readonly mode: 'chunks' | 'events';
}

/** Messages published on the Studio live feed (`GET /__tokenfault/api/live`, SSE). */
export type LiveMessage =
  | { readonly type: 'snapshot'; readonly sessions: readonly SessionSummary[] }
  | { readonly type: 'session-started'; readonly session: SessionSummary }
  | {
      readonly type: 'session-progress';
      readonly session: SessionSummary;
      readonly events: readonly CapturedEvent[];
      readonly annotations: readonly FaultAnnotation[];
    }
  | { readonly type: 'session-ended'; readonly session: SessionSummary }
  | { readonly type: 'sessions-cleared' }
  | { readonly type: 'faults-changed'; readonly activeFaults: ActiveFaults | null };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TokenFaultErrorCode =
  | 'tokenfault_invalid_request'
  | 'tokenfault_forbidden'
  | 'tokenfault_not_found'
  | 'tokenfault_payload_too_large'
  | 'tokenfault_upstream_unreachable'
  | 'tokenfault_upstream_timeout'
  | 'tokenfault_upstream_error'
  | 'tokenfault_method_not_allowed'
  | 'tokenfault_internal';

/** Error body shape. Mirrors the OpenAI `{ error: {...} }` envelope so existing clients can parse it. */
export interface ErrorBody {
  readonly error: {
    readonly type: 'tokenfault_error';
    readonly code: TokenFaultErrorCode;
    readonly message: string;
  };
}
