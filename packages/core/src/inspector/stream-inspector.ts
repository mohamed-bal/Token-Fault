/**
 * StreamInspector: the single place where a response byte stream becomes
 * inspectable data (captured chunks and events, diagnostics, metrics and an
 * assembled response).
 *
 * It is fed exactly what the client receives, with timestamps supplied by the
 * caller, so it is deterministic and transport-agnostic. The proxy, the CLI
 * `inspect` command, the testing helpers and replay all use it.
 *
 * Every buffer is bounded by `limits`. When a limit is hit, data stops being
 * stored, but counting continues, so metrics stay exact.
 */
import { DEFAULT_LIMITS, captureResponseHeaders } from '@tokenfault/shared';
import type {
  AssembledChoice,
  CapturedChunk,
  CapturedEvent,
  CompletionSignal,
  Diagnostic,
  DiagnosticSeverity,
  EventInterpretation,
  HeaderInput,
  StreamMetrics,
  StreamOutcome,
  Termination,
  TokenUsage,
} from '@tokenfault/shared';
import { SseDecoder } from '../sse/decoder.js';
import type { SseEvent } from '../sse/decoder.js';
import { ChatStreamAccumulator, interpretChatEventData } from '../openai/chat-stream.js';
import type { ChatDiagnostic, ChatStreamItem } from '../openai/chat-stream.js';
import { MAX_TRACKED_GAPS, computeGapStats, round } from '../metrics/gaps.js';
import { bytesToBase64 } from '../util/base64.js';

export interface InspectorLimits {
  readonly maxEventBytes: number;
  readonly maxEventsPerSession: number;
  readonly maxChunksPerSession: number;
  readonly maxCapturedBytesPerSession: number;
}

export interface StreamInspectorOptions {
  /** Retain payload data (event data, chunk bytes, content). Default `true`. */
  readonly capturePayloads?: boolean;
  readonly limits?: Partial<InspectorLimits>;
  /** Maximum diagnostics retained (further ones are counted only). Default 1000. */
  readonly maxDiagnostics?: number;
}

export interface InspectorUpdate {
  readonly events: readonly CapturedEvent[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface InspectorSnapshot {
  readonly status: number | null;
  readonly outcome: StreamOutcome;
  readonly completionSignal: CompletionSignal;
  readonly termination: Termination | null;
  readonly metrics: StreamMetrics;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly choices: readonly AssembledChoice[];
  readonly diagnosticCounts: Readonly<Record<DiagnosticSeverity, number>>;
  readonly truncated: boolean;
  readonly droppedEvents: number;
  readonly droppedChunks: number;
}

const EMPTY_INTERPRETATION: Omit<EventInterpretation, 'kind'> = {
  content: null,
  contentLength: 0,
  roles: [],
  finishReasons: [],
  toolCalls: [],
  usage: null,
  error: null,
  unknownKeys: [],
};

export class StreamInspector {
  readonly capturePayloads: boolean;
  private readonly limits: InspectorLimits;
  private readonly maxDiagnostics: number;
  private readonly decoder: SseDecoder;
  private readonly accumulator: ChatStreamAccumulator;

  readonly events: CapturedEvent[] = [];
  readonly chunks: CapturedChunk[] = [];
  readonly diagnostics: Diagnostic[] = [];

  private status: number | null = null;
  private responseHeaders: Record<string, string> = {};
  private isSse = false;
  private decodeBody = false;
  private termination: Termination | null = null;
  private capturedBytes = 0;
  private truncated = false;
  private droppedEvents = 0;
  private droppedChunks = 0;
  private droppedDiagnostics = 0;
  private readonly diagnosticCounts: Record<DiagnosticSeverity, number> = {
    info: 0,
    warning: 0,
    error: 0,
  };

  // Metrics state.
  private headersMs: number | null = null;
  private firstByteMs: number | null = null;
  private firstEventMs: number | null = null;
  private firstContentMs: number | null = null;
  private lastEventMs: number | null = null;
  private eventCount = 0;
  private chunkCount = 0;
  private byteCount = 0;
  private contentDeltaCount = 0;
  private toolCallDeltaCount = 0;
  private readonly gaps: number[] = [];
  private usage: TokenUsage | null = null;

  constructor(options: StreamInspectorOptions = {}) {
    this.capturePayloads = options.capturePayloads ?? true;
    this.limits = {
      maxEventBytes: options.limits?.maxEventBytes ?? DEFAULT_LIMITS.maxEventBytes,
      maxEventsPerSession:
        options.limits?.maxEventsPerSession ?? DEFAULT_LIMITS.maxEventsPerSession,
      maxChunksPerSession:
        options.limits?.maxChunksPerSession ?? DEFAULT_LIMITS.maxChunksPerSession,
      maxCapturedBytesPerSession:
        options.limits?.maxCapturedBytesPerSession ?? DEFAULT_LIMITS.maxCapturedBytesPerSession,
    };
    this.maxDiagnostics = options.maxDiagnostics ?? 1000;
    this.decoder = new SseDecoder({ maxEventBytes: this.limits.maxEventBytes });
    this.accumulator = new ChatStreamAccumulator({
      retainPayloads: this.capturePayloads,
      maxRetainedChars: this.limits.maxCapturedBytesPerSession,
    });
  }

  /** Records the response status line and headers. */
  onHeaders(status: number, headers: HeaderInput, atMs: number): Diagnostic[] {
    this.status = status;
    this.headersMs = round(atMs);
    this.responseHeaders = captureResponseHeaders(headers);
    const contentType = (this.responseHeaders['content-type'] ?? '').toLowerCase();
    const encoding = (this.responseHeaders['content-encoding'] ?? 'identity').toLowerCase().trim();
    this.isSse = contentType.startsWith('text/event-stream');
    const added: Diagnostic[] = [];
    if (encoding !== 'identity' && encoding !== '') {
      added.push(
        this.addDiagnostic({
          code: 'transport-compressed-body',
          severity: 'warning',
          message: `Response body is "${encoding}"-encoded; bytes are forwarded untouched but not decoded for inspection.`,
          atMs: round(atMs),
          eventSeq: null,
        }),
      );
      this.decodeBody = false;
    } else {
      this.decodeBody = this.isSse;
    }
    if (
      !this.isSse &&
      status < 400 &&
      contentType !== '' &&
      !contentType.startsWith('application/json')
    ) {
      added.push(
        this.addDiagnostic({
          code: 'transport-non-sse-content-type',
          severity: 'info',
          message: `Response content-type is "${contentType}", not text/event-stream; SSE decoding is disabled.`,
          atMs: round(atMs),
          eventSeq: null,
        }),
      );
    }
    return added;
  }

  /** Feeds bytes delivered to the client. */
  onChunk(bytes: Uint8Array, atMs: number): InspectorUpdate {
    if (this.termination) throw new Error('StreamInspector.onChunk() after onEnd()');
    if (bytes.length === 0) return { events: [], diagnostics: [] };
    const t = round(atMs);
    this.firstByteMs ??= t;
    this.chunkCount += 1;
    this.byteCount += bytes.length;
    if (this.chunks.length < this.limits.maxChunksPerSession) {
      this.chunks.push({
        seq: this.chunkCount - 1,
        atMs: t,
        byteLength: bytes.length,
        dataBase64: this.tryCapture(bytes.length) ? bytesToBase64(bytes) : null,
      });
    } else {
      this.droppedChunks += 1;
      this.markTruncated(t);
    }
    if (!this.decodeBody) return { events: [], diagnostics: [] };
    return this.processItems(this.decoder.push(bytes), t);
  }

  /** Marks the end of the response. Idempotent: only the first termination is kept. */
  onEnd(termination: Termination): InspectorUpdate {
    if (this.termination) return { events: [], diagnostics: [] };
    const t = round(termination.atMs);
    this.termination = { ...termination, atMs: t };
    let update: InspectorUpdate = { events: [], diagnostics: [] };
    if (this.decodeBody) {
      update = this.processItems(this.decoder.end(), t);
      const clean = termination.kind === 'eof' || termination.kind === 'replay-end';
      if (this.status !== null && this.status < 400) {
        const diags = this.accumulator
          .finalize(clean)
          .map((d) => this.addDiagnostic(chatToDiagnostic(d, t, null)));
        update = { events: update.events, diagnostics: [...update.diagnostics, ...diags] };
      }
    }
    return update;
  }

  get outcome(): StreamOutcome {
    if (this.status !== null && this.status >= 400) return 'http-error';
    if (!this.termination) return 'pending';
    if (this.status === null) return 'incomplete';
    if (!this.isSse) return 'non-stream';
    if (!this.decodeBody) return 'incomplete';
    const clean = this.termination.kind === 'eof' || this.termination.kind === 'replay-end';
    return this.accumulator.verdict(clean).outcome;
  }

  snapshot(): InspectorSnapshot {
    const outcome = this.outcome;
    const clean = this.termination?.kind === 'eof' || this.termination?.kind === 'replay-end';
    return {
      status: this.status,
      outcome,
      completionSignal:
        outcome === 'completed' && this.decodeBody
          ? this.accumulator.verdict(clean).completionSignal
          : null,
      termination: this.termination,
      metrics: this.metrics(),
      responseHeaders: this.responseHeaders,
      choices: this.accumulator.assemble(),
      diagnosticCounts: { ...this.diagnosticCounts },
      truncated: this.truncated || this.accumulator.retentionTruncated,
      droppedEvents: this.droppedEvents,
      droppedChunks: this.droppedChunks,
    };
  }

  metrics(): StreamMetrics {
    return {
      headersMs: this.headersMs,
      firstByteMs: this.firstByteMs,
      firstEventMs: this.firstEventMs,
      firstContentMs: this.firstContentMs,
      durationMs: this.termination ? this.termination.atMs : null,
      eventCount: this.eventCount,
      chunkCount: this.chunkCount,
      byteCount: this.byteCount,
      contentDeltaCount: this.contentDeltaCount,
      toolCallDeltaCount: this.toolCallDeltaCount,
      eventGaps: computeGapStats(this.gaps),
      usage: this.usage,
    };
  }

  private processItems(items: ReturnType<SseDecoder['push']>, t: number): InspectorUpdate {
    const events: CapturedEvent[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const item of items) {
      if (item.kind === 'diagnostic') {
        diagnostics.push(
          this.addDiagnostic({
            code: item.diagnostic.code,
            severity: item.diagnostic.severity,
            message: item.diagnostic.message,
            atMs: t,
            eventSeq: null,
          }),
        );
      } else if (item.kind === 'event') {
        const captured = this.processEvent(item.event, t, diagnostics);
        if (captured) events.push(captured);
      }
      // Comments (keep-alives) are not events. They are visible in raw chunks.
    }
    return { events, diagnostics };
  }

  private processEvent(event: SseEvent, t: number, sink: Diagnostic[]): CapturedEvent | null {
    const seq = this.eventCount;
    this.eventCount += 1;
    this.firstEventMs ??= t;
    if (this.lastEventMs !== null && this.gaps.length < MAX_TRACKED_GAPS)
      this.gaps.push(round(t - this.lastEventMs));
    this.lastEventMs = t;

    const item = interpretChatEventData(event.data);
    const eventDiagnostics = this.accumulator.apply(item).map((d) => chatToDiagnostic(d, t, seq));
    for (const d of eventDiagnostics) sink.push(this.addDiagnostic(d));

    const interpretation = this.interpret(item);
    if (interpretation.contentLength > 0) this.contentDeltaCount += 1;
    if (interpretation.toolCalls.length > 0) this.toolCallDeltaCount += 1;
    if (interpretation.contentLength > 0 || interpretation.toolCalls.length > 0)
      this.firstContentMs ??= t;
    if (interpretation.usage) this.usage = interpretation.usage;

    if (this.events.length >= this.limits.maxEventsPerSession) {
      this.droppedEvents += 1;
      this.markTruncated(t);
      return null;
    }
    const keepData = this.tryCapture(event.dataByteLength);
    const captured: CapturedEvent = {
      seq,
      atMs: t,
      event: event.type,
      id: event.id,
      retry: event.retry,
      data: keepData ? event.data : null,
      dataByteLength: event.dataByteLength,
      rawByteLength: event.endOffset - event.startOffset,
      interpretation: keepData ? interpretation : redactInterpretation(interpretation),
      diagnostics: eventDiagnostics,
    };
    this.events.push(captured);
    return captured;
  }

  private interpret(item: ChatStreamItem): EventInterpretation {
    switch (item.kind) {
      case 'done':
        return { kind: 'done', ...EMPTY_INTERPRETATION };
      case 'invalid-json':
        return { kind: 'invalid-json', ...EMPTY_INTERPRETATION };
      case 'unrecognized':
        return { kind: 'unrecognized', ...EMPTY_INTERPRETATION, unknownKeys: item.topLevelKeys };
      case 'error':
        return { kind: 'error', ...EMPTY_INTERPRETATION, error: item.error };
      case 'chunk': {
        const chunk = item.chunk;
        let content = '';
        let hasContent = false;
        const roles: string[] = [];
        const finishReasons: { choiceIndex: number; reason: string }[] = [];
        const toolCalls: EventInterpretation['toolCalls'][number][] = [];
        for (const choice of chunk.choices) {
          if (choice.content !== null) {
            content += choice.content;
            hasContent = true;
          }
          if (choice.role !== null) roles.push(choice.role);
          if (choice.finishReason !== null)
            finishReasons.push({ choiceIndex: choice.index, reason: choice.finishReason });
          for (const tc of choice.toolCalls) {
            toolCalls.push({
              choiceIndex: choice.index,
              index: tc.index,
              id: tc.id,
              type: tc.type,
              name: tc.name,
              argumentsFragment: tc.arguments,
              argumentsFragmentLength: tc.arguments?.length ?? 0,
            });
          }
        }
        return {
          kind: 'chunk',
          content: hasContent ? content : null,
          contentLength: content.length,
          roles,
          finishReasons,
          toolCalls,
          usage: chunk.usage,
          error: null,
          unknownKeys: chunk.unknownKeys,
        };
      }
    }
  }

  private tryCapture(bytes: number): boolean {
    if (!this.capturePayloads) return false;
    if (this.capturedBytes + bytes > this.limits.maxCapturedBytesPerSession) {
      this.markTruncated(this.lastEventMs ?? this.firstByteMs ?? 0);
      return false;
    }
    this.capturedBytes += bytes;
    return true;
  }

  private markTruncated(t: number): void {
    if (this.truncated) return;
    this.truncated = true;
    this.addDiagnostic({
      code: 'transport-capture-truncated',
      severity: 'info',
      message: 'A capture limit was reached; further payload data is counted but not stored.',
      atMs: t,
      eventSeq: null,
    });
  }

  private addDiagnostic(d: Diagnostic): Diagnostic {
    this.diagnosticCounts[d.severity] += 1;
    if (this.diagnostics.length < this.maxDiagnostics) this.diagnostics.push(d);
    else this.droppedDiagnostics += 1;
    return d;
  }
}

function chatToDiagnostic(d: ChatDiagnostic, atMs: number, eventSeq: number | null): Diagnostic {
  return { code: d.code, severity: d.severity, message: d.message, atMs, eventSeq };
}

function redactInterpretation(i: EventInterpretation): EventInterpretation {
  return {
    ...i,
    content: null,
    error: i.error ? { ...i.error, message: '[redacted]' } : null,
    toolCalls: i.toolCalls.map((tc) => ({ ...tc, argumentsFragment: null })),
  };
}
