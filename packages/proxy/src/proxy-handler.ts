/**
 * The streaming proxy data path.
 *
 * One `ProxyExchange` handles one client request:
 *
 *   client ──► [pre-response faults] ──► upstream request
 *          ◄── [headers] ◄── [FaultedResponseWriter: framing + faults] ◄── upstream body
 *
 * Guarantees:
 * - Streaming: upstream chunks are written as they arrive; the body is never buffered whole.
 * - Backpressure: the next upstream chunk is not read until the client socket accepted the
 *   previous write, so a slow client throttles the upstream (TCP flow control).
 * - Cancellation: a client disconnect aborts the upstream request; timeouts abort it too.
 * - Honest failures: an upstream failure after headers terminates the client connection
 *   abnormally. It is never turned into a clean end of stream.
 * - Every exchange ends with exactly one recorded termination.
 */
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { FaultPlanner, findScenario, selectFaults, sleep } from '@tokenfault/core';
import type { FaultSelection, FaultSpec } from '@tokenfault/core';
import {
  ClientGoneError,
  FaultedResponseWriter,
  endResponse,
  terminateResponse,
} from '@tokenfault/core/node';
import {
  CONTROL_PREFIX,
  FAULTS_HEADER,
  SCENARIO_HEADER,
  SESSION_HEADER,
  describeError,
  errorBody,
  redactPathQuery,
} from '@tokenfault/shared';
import type { Limits, RequestMeta, TerminationKind, TokenFaultErrorCode } from '@tokenfault/shared';
import {
  RESPONSE_ISOLATION_HEADERS,
  forwardRequestHeaders,
  forwardResponseHeaders,
} from './headers.js';
import type { Session, SessionStore } from './session-store.js';
import { buildUpstreamUrl } from './target.js';
import type { UpstreamTarget } from './target.js';

export interface ProxyContext {
  readonly target: UpstreamTarget;
  readonly store: SessionStore;
  readonly limits: Limits;
  readonly headersTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number | null;
  readonly activeFaults: () => FaultSelection | null;
  readonly logger: FastifyBaseLogger;
}

const FORWARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const EMPTY_PROFILE = { faults: [], seed: 1 };

function sendError(
  reply: FastifyReply,
  status: number,
  code: TokenFaultErrorCode,
  message: string,
): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'application/json')
    .send(errorBody(code, message));
}

/** Extracts non-sensitive request facts. The prompt content is never read into the session. */
export function extractRequestMeta(body: Buffer, contentType: string | undefined): RequestMeta {
  const meta: {
    model: string | null;
    stream: boolean | null;
    messageCount: number | null;
    toolCount: number | null;
  } = {
    model: null,
    stream: null,
    messageCount: null,
    toolCount: null,
  };
  if (body.length > 0 && (contentType ?? '').toLowerCase().includes('json')) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>;
        if (typeof p['model'] === 'string') meta.model = p['model'].slice(0, 256);
        if (typeof p['stream'] === 'boolean') meta.stream = p['stream'];
        if (Array.isArray(p['messages'])) meta.messageCount = p['messages'].length;
        if (Array.isArray(p['tools'])) meta.toolCount = p['tools'].length;
      }
    } catch {
      // Not JSON: only the size is recorded.
    }
  }
  return { ...meta, bodyBytes: body.length };
}

/** True if the raw or percent-decoded path is under the reserved control prefix (never forwarded). */
function targetsControlPrefix(rawUrl: string): boolean {
  const matches = (p: string): boolean =>
    p === CONTROL_PREFIX ||
    p.startsWith(`${CONTROL_PREFIX}/`) ||
    p.startsWith(`${CONTROL_PREFIX}?`);
  if (matches(rawUrl)) return true;
  try {
    return matches(decodeURIComponent(rawUrl.split('?', 1)[0] ?? ''));
  } catch {
    return false;
  }
}

export async function handleProxyRequest(
  ctx: ProxyContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawUrl = request.raw.url ?? '/';
  if (targetsControlPrefix(rawUrl)) {
    await sendError(reply, 404, 'tokenfault_not_found', 'Unknown TokenFault control endpoint.');
    return;
  }
  if (!FORWARD_METHODS.has(request.method)) {
    await sendError(
      reply,
      405,
      'tokenfault_method_not_allowed',
      `Method ${request.method} is not forwarded.`,
    );
    return;
  }
  const upstreamUrl = buildUpstreamUrl(ctx.target, rawUrl);
  if (!upstreamUrl) {
    await sendError(
      reply,
      400,
      'tokenfault_invalid_request',
      'Request target is not an acceptable origin-form path for the configured upstream.',
    );
    return;
  }
  // A per-request scenario that only the mock server can apply (it shapes generated content)
  // is delegated: the proxy applies no faults itself and forwards the scenario header upstream.
  const requestedScenario = request.headers[SCENARIO_HEADER];
  const mockOnly =
    typeof requestedScenario === 'string' ? findScenario(requestedScenario.trim()) : undefined;
  const delegatedScenario =
    mockOnly && !mockOnly.descriptor.appliesTo.includes('proxy') ? mockOnly.descriptor.id : null;
  const selection = delegatedScenario
    ? ({ ok: true, value: null } as const)
    : selectFaults(
        { scenario: requestedScenario, faults: request.headers[FAULTS_HEADER] },
        'proxy',
        ctx.activeFaults(),
        ctx.limits.maxFaultHeaderBytes,
      );
  if (!selection.ok) {
    await sendError(
      reply,
      400,
      'tokenfault_invalid_request',
      `Invalid fault selection: ${selection.error}`,
    );
    return;
  }

  const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const faults: readonly FaultSpec[] = selection.value?.profile.faults ?? [];
  const session = ctx.store.create(
    {
      id: request.id,
      source: 'proxy',
      startedAt: new Date().toISOString(),
      method: request.method,
      path: redactPathQuery(rawUrl),
      scenarioId: delegatedScenario ?? selection.value?.scenarioId ?? null,
      faults,
      request: extractRequestMeta(body, request.headers['content-type']),
      replayOf: null,
    },
    selection.value?.profile.seed ?? null,
  );

  reply.hijack();
  const exchange = new ProxyExchange(
    ctx,
    request,
    reply.raw,
    session,
    upstreamUrl,
    body,
    new FaultPlanner(selection.value?.profile ?? EMPTY_PROFILE),
    delegatedScenario,
  );
  await exchange.run();
}

class ProxyExchange {
  private readonly started = performance.now();
  private readonly clientController = new AbortController();
  private readonly upstreamController = new AbortController();
  private timeoutReason: 'headers' | 'idle' | 'total' | null = null;
  private headersTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private totalTimer: NodeJS.Timeout | null = null;
  private finished = false;

  constructor(
    private readonly ctx: ProxyContext,
    private readonly request: FastifyRequest,
    private readonly res: ServerResponse,
    private readonly session: Session,
    private readonly upstreamUrl: URL,
    private readonly body: Buffer,
    private readonly planner: FaultPlanner,
    private readonly delegatedScenario: string | null,
  ) {
    res.on('close', () => {
      if (!res.writableFinished) this.clientController.abort();
    });
    this.clientController.signal.addEventListener('abort', () => this.upstreamController.abort(), {
      once: true,
    });
  }

  private now(): number {
    return performance.now() - this.started;
  }

  async run(): Promise<void> {
    try {
      const pre = this.planner.preResponse();
      if (pre.delayMs > 0) {
        this.annotate(
          'delay-first-byte',
          `Holding the response for ${pre.delayMs} ms before the first byte.`,
        );
        if (!(await sleep(pre.delayMs, this.clientController.signal)))
          return this.finish('client-abort', null);
      }
      if (pre.error) return this.injectHttpError(pre.error);

      if (this.ctx.totalTimeoutMs !== null) {
        this.totalTimer = setTimeout(() => this.timeout('total'), this.ctx.totalTimeoutMs);
      }
      const upstream = await this.openUpstream();
      if (!upstream) return;
      await this.pipe(upstream);
    } catch (error) {
      this.ctx.logger.error(
        { session: this.session.id, err: describeError(error) },
        'proxy exchange failed',
      );
      if (!this.res.headersSent) {
        this.writeJsonError(500, 'tokenfault_internal', 'TokenFault proxy internal error.');
      } else {
        terminateResponse(this.res, 'destroy');
      }
      this.finish('proxy-error', describeError(error));
    } finally {
      this.clearTimers();
      if (!this.finished) this.finish('proxy-error', 'exchange ended without termination');
    }
  }

  private injectHttpError(error: Extract<FaultSpec, { type: 'http-error' }>): void {
    this.annotate('http-error', `Injected HTTP ${error.status} before contacting upstream.`);
    const status = error.status;
    const payload = JSON.stringify({
      error: {
        message: error.message ?? `Injected HTTP ${status} (TokenFault).`,
        type:
          status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'server_error'
              : 'invalid_request_error',
        param: null,
        code:
          status === 429
            ? 'rate_limit_exceeded'
            : status === 503
              ? 'service_unavailable'
              : `http_${status}`,
      },
    });
    const headers: OutgoingHttpHeaders = {
      ...RESPONSE_ISOLATION_HEADERS,
      'content-type': 'application/json',
      [SESSION_HEADER]: this.session.id,
    };
    if (error.retryAfterSeconds !== undefined)
      headers['retry-after'] = String(error.retryAfterSeconds);
    this.ctx.store.onHeaders(this.session, status, headers, this.now());
    this.res.writeHead(status, headers);
    const bytes = Buffer.from(payload);
    this.res.end(bytes);
    this.ctx.store.recordChunk(this.session, bytes, this.now());
    this.finish('eof', null);
  }

  private openUpstream(): Promise<IncomingMessage | null> {
    const headers = forwardRequestHeaders(
      this.request.headers,
      this.body.length,
      this.request.method,
    );
    if (this.delegatedScenario !== null) {
      headers[SCENARIO_HEADER] = this.delegatedScenario;
      this.annotate(
        'delegated',
        `Scenario "${this.delegatedScenario}" is applied by the upstream mock server, not by the proxy.`,
      );
    }
    const requestFn = this.upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    this.headersTimer = setTimeout(() => this.timeout('headers'), this.ctx.headersTimeoutMs);

    return new Promise((resolve) => {
      // Exactly one of: response, error, upgrade, or close-without-response settles the exchange.
      let settled = false;
      const failBeforeHeaders = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (this.headersTimer) clearTimeout(this.headersTimer);
        this.headersTimer = null;
        if (this.clientController.signal.aborted) {
          this.finish('client-abort', null);
        } else if (this.timeoutReason !== null) {
          this.writeJsonError(
            504,
            'tokenfault_upstream_timeout',
            this.timeoutReason === 'total'
              ? `Upstream exchange exceeded the total timeout of ${this.ctx.totalTimeoutMs ?? 0} ms before response headers.`
              : `Upstream did not send response headers within ${this.ctx.headersTimeoutMs} ms.`,
          );
          this.finish('upstream-timeout', `${this.timeoutReason} timeout`);
        } else {
          this.writeJsonError(
            502,
            'tokenfault_upstream_unreachable',
            `Upstream request to ${this.ctx.target.display} failed: ${describeError(error)}`,
          );
          this.finish('upstream-unreachable', describeError(error));
        }
        resolve(null);
      };
      const upstreamReq = requestFn(this.upstreamUrl, {
        method: this.request.method,
        headers,
        signal: this.upstreamController.signal,
      });
      upstreamReq.on('response', (upstreamRes) => {
        if (settled) {
          upstreamRes.destroy();
          return;
        }
        settled = true;
        if (this.headersTimer) clearTimeout(this.headersTimer);
        this.headersTimer = null;
        resolve(upstreamRes);
      });
      // Body-phase errors surface on the response stream; only pre-response errors land here.
      upstreamReq.on('error', (error) => failBeforeHeaders(error));
      // Protocol switches are never proxied (the proxy only forwards HTTP request/response
      // exchanges). Without this handler Node emits neither 'response' nor 'error' and the
      // exchange would hang forever.
      upstreamReq.on('upgrade', (_res, socket) => {
        socket.destroy();
        failBeforeHeaders(
          new Error('upstream attempted a protocol upgrade (101), which TokenFault does not proxy'),
        );
      });
      upstreamReq.on('close', () =>
        failBeforeHeaders(new Error('upstream closed the connection before sending a response')),
      );
      upstreamReq.end(this.body.length > 0 ? this.body : undefined);
    });
  }

  private async pipe(upstream: IncomingMessage): Promise<void> {
    const status = upstream.statusCode ?? 502;
    const contentType = String(upstream.headers['content-type'] ?? '').toLowerCase();
    const encoding = String(upstream.headers['content-encoding'] ?? 'identity').toLowerCase();
    // Frame-level faults only make sense on an uncompressed, successful SSE body.
    const framing =
      contentType.startsWith('text/event-stream') &&
      status < 300 &&
      (encoding === 'identity' || encoding === '');

    const headers = forwardResponseHeaders(upstream.headers);
    headers[SESSION_HEADER] = this.session.id;
    this.ctx.store.onHeaders(this.session, status, upstream.headers, this.now());
    this.res.writeHead(status, headers);
    this.res.flushHeaders();
    this.res.socket?.setNoDelay(true);

    const writer = new FaultedResponseWriter(
      this.res,
      this.planner,
      {
        onWrite: (bytes) => this.ctx.store.recordChunk(this.session, bytes, this.now()),
        onAnnotate: (faultType, message) => this.annotate(faultType, message),
        onDisconnect: (mode) => {
          this.upstreamController.abort();
          this.finish('fault-disconnect', `mode=${mode}`);
        },
      },
      this.clientController.signal,
      { framing, maxEventBytes: this.ctx.limits.maxEventBytes },
    );
    writer.start();
    this.armIdleTimer(upstream);
    try {
      for await (const chunk of upstream) {
        // The idle timer measures upstream silence only while we are actually reading. It is paused
        // while the proxy itself waits (injected stalls/jitter, or a slow client applying backpressure).
        this.pauseIdleTimer();
        const buf = chunk as Buffer;
        const ok = await writer.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (!ok) break;
        this.armIdleTimer(upstream);
      }
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (writer.disconnected) {
        upstream.destroy();
        return;
      }
      if (this.clientController.signal.aborted) {
        upstream.destroy();
        return this.finish('client-abort', null);
      }
      if (await writer.end()) {
        await endResponse(this.res);
        return this.finish(this.res.writableFinished ? 'eof' : 'client-abort', null);
      }
      if (!writer.disconnected) this.finish('client-abort', null);
    } catch (error) {
      upstream.destroy();
      if (writer.disconnected) return;
      if (this.clientController.signal.aborted || error instanceof ClientGoneError) {
        return this.finish('client-abort', null);
      }
      terminateResponse(this.res, 'destroy');
      if (this.timeoutReason !== null) {
        return this.finish(
          'upstream-timeout',
          this.timeoutReason === 'idle'
            ? `no upstream data for ${this.ctx.idleTimeoutMs} ms`
            : 'total timeout',
        );
      }
      return this.finish('upstream-reset', describeError(error));
    } finally {
      writer.dispose();
    }
  }

  private pauseIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(upstream: IncomingMessage): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.timeoutReason = 'idle';
      upstream.destroy(new Error(`Upstream idle for ${this.ctx.idleTimeoutMs} ms`));
    }, this.ctx.idleTimeoutMs);
  }

  private timeout(reason: 'headers' | 'total'): void {
    if (this.finished) return;
    this.timeoutReason = reason;
    this.upstreamController.abort();
  }

  private writeJsonError(status: number, code: TokenFaultErrorCode, message: string): void {
    if (this.res.headersSent || this.res.destroyed) return;
    const payload = Buffer.from(JSON.stringify(errorBody(code, message)));
    const headers = {
      ...RESPONSE_ISOLATION_HEADERS,
      'content-type': 'application/json',
      [SESSION_HEADER]: this.session.id,
    };
    this.ctx.store.onHeaders(this.session, status, headers, this.now());
    this.res.writeHead(status, headers);
    this.res.end(payload);
    this.ctx.store.recordChunk(this.session, payload, this.now());
  }

  private annotate(faultType: string, message: string): void {
    this.ctx.store.annotate(this.session, {
      atMs: Math.round(this.now() * 1000) / 1000,
      faultType,
      message,
      afterEvents: this.planner.eventsDelivered,
    });
  }

  private clearTimers(): void {
    for (const timer of [this.headersTimer, this.idleTimer, this.totalTimer])
      if (timer) clearTimeout(timer);
    this.headersTimer = this.idleTimer = this.totalTimer = null;
  }

  private finish(kind: TerminationKind, detail: string | null): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    this.ctx.store.end(this.session, { kind, atMs: this.now(), detail });
    const summary = this.session.summary();
    this.ctx.logger.info(
      {
        session: this.session.id,
        method: this.request.method,
        path: summary.path,
        status: summary.status,
        outcome: summary.outcome,
        termination: kind,
        durationMs: summary.metrics.durationMs,
      },
      'proxied request',
    );
  }
}
