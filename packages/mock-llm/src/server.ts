/**
 * OpenAI-compatible mock LLM server.
 *
 * Implements `POST /v1/chat/completions` (streaming and non-streaming),
 * `GET /v1/models` and `GET /healthz`. Responses are deterministic for a given
 * request. Every fault scenario can be selected per request via
 * `x-tokenfault-scenario` / `x-tokenfault-faults`, or by default for all requests.
 */
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  FaultPlanner,
  findScenario,
  parseFaultProfile,
  selectFaults,
  sleep,
  WaitPacer,
} from '@tokenfault/core';
import type { FaultProfileInput, FaultSelection, FaultSpec } from '@tokenfault/core';
import { FaultedResponseWriter } from '@tokenfault/core/node';
import {
  DEFAULT_LIMITS,
  FAULTS_HEADER,
  SCENARIO_HEADER,
  describeError,
  redactPathQuery,
} from '@tokenfault/shared';
import { ChatRequestSchema } from './request.js';
import type { ChatRequest } from './request.js';
import { completionBody, planCompletion, streamFrames } from './completion.js';

export interface MockLlmOptions {
  /** Default scenario applied when a request selects none. */
  readonly scenarioId?: string | null;
  /** Default fault profile applied when a request selects none (ignored if `scenarioId` is set). */
  readonly faults?: FaultProfileInput | null;
  /** Delay between consecutive SSE events in ms. Default 20. */
  readonly eventIntervalMs?: number;
  /** Characters per tool-call arguments fragment when no fault overrides it. Default 16. */
  readonly toolChunkChars?: number;
  readonly maxRequestBodyBytes?: number;
  /** Enable Fastify/pino request logging. Default `false`. */
  readonly logger?: boolean;
  /** Clock for the `created` field (Unix seconds). */
  readonly now?: () => number;
}

export const MOCK_MODEL_ID = 'tokenfault-mock-1';

const OptionsSchema = z.strictObject({
  scenarioId: z.string().max(128).nullable().optional(),
  faults: z.unknown().optional(),
  eventIntervalMs: z.number().int().min(0).max(60_000).optional(),
  toolChunkChars: z.number().int().min(1).max(1_000).optional(),
  maxRequestBodyBytes: z
    .number()
    .int()
    .min(1_024)
    .max(512 * 1024 * 1024)
    .optional(),
  logger: z.boolean().optional(),
  now: z.function().optional(),
});

function openAiError(
  reply: FastifyReply,
  status: number,
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
) {
  return reply.code(status).send({ error: { message, type, param, code } });
}

/** Resolves the default fault selection from options. Throws on invalid configuration. */
function resolveDefaultFaults(options: MockLlmOptions): FaultSelection | null {
  if (options.scenarioId) {
    const scenario = findScenario(options.scenarioId);
    if (!scenario) throw new Error(`Unknown scenario "${options.scenarioId}"`);
    return { scenarioId: scenario.descriptor.id, profile: scenario.profile };
  }
  if (options.faults) {
    const parsed = parseFaultProfile(options.faults, 'mock');
    if (!parsed.ok) throw new Error(`Invalid fault profile: ${parsed.error}`);
    return { scenarioId: null, profile: parsed.value };
  }
  return null;
}

export function buildMockLlmServer(options: MockLlmOptions = {}): FastifyInstance {
  const checked = OptionsSchema.safeParse(options);
  if (!checked.success)
    throw new Error(`Invalid mock server options:\n${z.prettifyError(checked.error)}`);
  const defaults = resolveDefaultFaults(options);
  const interval = options.eventIntervalMs ?? 20;
  const toolChunkChars = options.toolChunkChars ?? 16;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          serializers: {
            req: (req: FastifyRequest) => ({ method: req.method, url: redactPathQuery(req.url) }),
          },
        }
      : false,
    bodyLimit: options.maxRequestBodyBytes ?? DEFAULT_LIMITS.maxRequestBodyBytes,
    forceCloseConnections: true,
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/v1/models', () => ({
    object: 'list',
    data: [{ id: MOCK_MODEL_ID, object: 'model', created: 0, owned_by: 'tokenfault' }],
  }));

  app.post('/v1/chat/completions', async (request, reply) => {
    const parsed = ChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return openAiError(
        reply,
        400,
        `Invalid request: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'malformed body'}`,
        'invalid_request_error',
        null,
        issue ? issue.path.join('.') : null,
      );
    }
    const body = parsed.data;
    if (body.n !== undefined && body.n > 1) {
      return openAiError(
        reply,
        400,
        'The TokenFault mock supports n=1 only.',
        'invalid_request_error',
        'unsupported_value',
        'n',
      );
    }

    const selection = selectFaults(
      { scenario: request.headers[SCENARIO_HEADER], faults: request.headers[FAULTS_HEADER] },
      'mock',
      defaults,
      DEFAULT_LIMITS.maxFaultHeaderBytes,
    );
    if (!selection.ok)
      return openAiError(
        reply,
        400,
        selection.error,
        'invalid_request_error',
        'tokenfault_invalid_faults',
      );

    return respond(request, reply, body, selection.value);
  });

  async function respond(
    request: FastifyRequest,
    reply: FastifyReply,
    body: ChatRequest,
    selection: FaultSelection | null,
  ) {
    const profile = selection?.profile ?? { faults: [], seed: 1 };
    const planner = new FaultPlanner(profile);
    const toolFault = profile.faults.find(
      (f): f is Extract<FaultSpec, { type: 'fragment-tool-calls' }> =>
        f.type === 'fragment-tool-calls',
    );
    const plan = planCompletion(body, {
      forceTool: toolFault !== undefined,
      toolChunkChars: toolFault?.chunkChars ?? toolChunkChars,
      created: now(),
    });

    // From here on the raw response is managed directly (timing and termination must be exact).
    reply.hijack();
    const res = reply.raw;
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const pre = planner.preResponse();
    if (pre.delayMs > 0 && !(await sleep(pre.delayMs, controller.signal))) return;

    const commonHeaders: Record<string, string> = { 'x-request-id': `req_${plan.id.slice(-8)}` };
    if (selection?.scenarioId) commonHeaders['x-tokenfault-scenario'] = selection.scenarioId;

    if (pre.error) {
      const status = pre.error.status;
      const errorBody = JSON.stringify({
        error: {
          message: pre.error.message ?? `Injected HTTP ${status} (TokenFault).`,
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
      res.writeHead(status, {
        ...commonHeaders,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(errorBody),
        ...(pre.error.retryAfterSeconds !== undefined
          ? { 'retry-after': String(pre.error.retryAfterSeconds) }
          : {}),
      });
      res.end(errorBody);
      return;
    }

    if (body.stream !== true) {
      const streamOnly = profile.faults
        .filter((f) => f.type !== 'delay-first-byte' && f.type !== 'http-error')
        .map((f) => f.type);
      const json = JSON.stringify(completionBody(plan));
      res.writeHead(200, {
        ...commonHeaders,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(json),
        ...(streamOnly.length > 0 ? { 'x-tokenfault-ignored-faults': streamOnly.join(',') } : {}),
      });
      res.end(json);
      return;
    }

    res.writeHead(200, {
      ...commonHeaders,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const writer = new FaultedResponseWriter(
      res,
      planner,
      {
        onWrite: () => undefined,
        onAnnotate: (faultType, message) => request.log.info({ faultType }, message),
        onDisconnect: () => undefined,
      },
      controller.signal,
    );
    writer.start();
    try {
      const frames = streamFrames(plan, body.stream_options?.include_usage === true);
      const encoder = new TextEncoder();
      // Paced, so the configured interval holds on coarse-timer platforms (Windows).
      const pacer = new WaitPacer();
      for (const [index, frame] of frames.entries()) {
        if (index > 0 && !(await pacer.wait(interval, controller.signal))) return;
        if (!(await writer.push(encoder.encode(frame)))) return;
      }
      if (!(await writer.end())) return;
      res.end();
    } catch (error) {
      // The client went away mid-write; nothing left to send.
      request.log.debug({ err: describeError(error) }, 'stream aborted');
      if (!res.destroyed) res.destroy();
    } finally {
      writer.dispose();
    }
  }

  return app;
}

export interface RunningMockLlm {
  readonly url: string;
  readonly app: FastifyInstance;
  close(): Promise<void>;
}

/** Starts the mock server. Binds to 127.0.0.1 by default. */
export async function startMockLlm(
  options: MockLlmOptions & { readonly host?: string; readonly port?: number } = {},
): Promise<RunningMockLlm> {
  const { host = '127.0.0.1', port = 0, ...rest } = options;
  const app = buildMockLlmServer(rest);
  await app.listen({ host, port });
  const address = app.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Mock server did not bind to a TCP port');
  const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${hostPart}:${address.port}`,
    app,
    close: () => app.close(),
  };
}
