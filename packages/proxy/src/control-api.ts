/**
 * Control API for the Studio and automation (`/__tokenfault/api/*`).
 *
 * Every route is reachable only through the loopback-only guard installed in
 * `server.ts` (DECISIONS.md D-011). Bodies arrive as raw buffers and are parsed
 * and validated explicitly here.
 */
import { request as httpRequest } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  FAULT_TYPES,
  SCENARIOS,
  createRecording,
  findScenario,
  parseFaultProfile,
  serializeRecording,
  validateRecording,
  validateTiming,
} from '@tokenfault/core';
import type { FaultSelection, Recording } from '@tokenfault/core';
import { API_PREFIX, SCENARIO_HEADER, SESSION_HEADER, errorBody } from '@tokenfault/shared';
import type {
  ActiveFaults,
  Limits,
  ProbeResponse,
  ReplayResponse,
  ReplayTiming,
  ServerInfo,
  TokenFaultErrorCode,
} from '@tokenfault/shared';
import { serveLiveFeed } from './live-feed.js';
import { ReplayLimitError } from './replay.js';
import type { ReplayManager } from './replay.js';
import type { SessionStore } from './session-store.js';

export interface ControlContext {
  readonly store: SessionStore;
  readonly replays: ReplayManager;
  readonly limits: Limits;
  readonly version: string;
  readonly targetDisplay: string;
  readonly targetBasePath: string;
  readonly recording: { readonly enabled: boolean; readonly includePayloads: boolean };
  getActive(): FaultSelection | null;
  setActive(selection: FaultSelection | null): void;
  /** Origin of this server's own listener, used by the probe. `null` until listening. */
  selfOrigin(): string | null;
}

function fail(
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

function parseJson(body: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

export function toActiveFaults(selection: FaultSelection | null): ActiveFaults | null {
  if (!selection) return null;
  return {
    scenarioId: selection.scenarioId,
    faults: selection.profile.faults,
    seed: selection.profile.seed,
  };
}

const TimingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('original') }),
  z.strictObject({ kind: z.literal('scaled'), factor: z.number() }),
  z.strictObject({ kind: z.literal('fixed'), gapMs: z.number().int() }),
]);

const ReplayBodySchema = z.strictObject({
  sessionId: z.string().max(64).optional(),
  recording: z.unknown().optional(),
  timing: TimingSchema.optional(),
});

const FaultsBodySchema = z.strictObject({
  scenarioId: z.string().max(128).optional(),
  profile: z.unknown().optional(),
});

const ProbeBodySchema = z.strictObject({
  model: z.string().min(1).max(256).optional(),
  prompt: z.string().max(2_000).optional(),
  scenarioId: z.string().max(128).optional(),
  withTools: z.boolean().optional(),
});

export function registerControlApi(app: FastifyInstance, ctx: ControlContext): void {
  app.get(`${API_PREFIX}/info`, (): ServerInfo => ({
    name: 'tokenfault',
    version: ctx.version,
    target: ctx.targetDisplay,
    payloadCapture: ctx.store.capturePayloads,
    recording: ctx.recording,
    activeFaults: toActiveFaults(ctx.getActive()),
    limits: {
      maxSessions: ctx.limits.maxSessions,
      maxEventsPerSession: ctx.limits.maxEventsPerSession,
      maxCapturedBytesPerSession: ctx.limits.maxCapturedBytesPerSession,
    },
  }));

  app.get(`${API_PREFIX}/health`, () => ({ status: 'ok' }));

  app.get(`${API_PREFIX}/scenarios`, () => ({
    scenarios: SCENARIOS.map((s) => s.descriptor),
    faultTypes: FAULT_TYPES,
  }));

  app.get(`${API_PREFIX}/sessions`, () => ({ sessions: ctx.store.list() }));

  app.delete(`${API_PREFIX}/sessions`, (_request, reply) => {
    ctx.store.clear();
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { chunks?: string } }>(
    `${API_PREFIX}/sessions/:id`,
    (request, reply) => {
      const session = ctx.store.get(request.params.id);
      if (!session)
        return fail(
          reply,
          404,
          'tokenfault_not_found',
          'Session not found (it may have been evicted).',
        );
      const detail = session.detail();
      return request.query.chunks === 'false' ? { ...detail, chunks: [] } : detail;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { payloads?: string } }>(
    `${API_PREFIX}/sessions/:id/recording`,
    (request, reply) => {
      const session = ctx.store.get(request.params.id);
      if (!session)
        return fail(
          reply,
          404,
          'tokenfault_not_found',
          'Session not found (it may have been evicted).',
        );
      if (!session.ended)
        return fail(
          reply,
          409,
          'tokenfault_invalid_request',
          'Session is still streaming; export it once it has ended.',
        );
      const recording = createRecording(session.detail(), {
        includePayloads: request.query.payloads === 'true',
        toolVersion: ctx.version,
        seed: session.seed,
      });
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="tokenfault-${session.id}.tfrec.json"`)
        .send(serializeRecording(recording));
    },
  );

  app.get(`${API_PREFIX}/live`, (_request, reply) => {
    reply.hijack();
    serveLiveFeed(reply.raw, ctx.store, { maxBufferBytes: ctx.limits.maxSubscriberBufferBytes });
  });

  app.get(`${API_PREFIX}/faults`, () => ({ activeFaults: toActiveFaults(ctx.getActive()) }));

  app.put(`${API_PREFIX}/faults`, (request, reply) => {
    const json = parseJson(request.body);
    if (!json.ok) return fail(reply, 400, 'tokenfault_invalid_request', json.error);
    const body = FaultsBodySchema.safeParse(json.value);
    if (!body.success)
      return fail(reply, 400, 'tokenfault_invalid_request', z.prettifyError(body.error));
    let selection: FaultSelection;
    if (body.data.scenarioId !== undefined) {
      const scenario = findScenario(body.data.scenarioId);
      if (!scenario)
        return fail(
          reply,
          400,
          'tokenfault_invalid_request',
          `Unknown scenario "${body.data.scenarioId}"`,
        );
      if (!scenario.descriptor.appliesTo.includes('proxy')) {
        return fail(
          reply,
          400,
          'tokenfault_invalid_request',
          `Scenario "${scenario.descriptor.id}" can only be applied by the mock server.`,
        );
      }
      selection = { scenarioId: scenario.descriptor.id, profile: scenario.profile };
    } else if (body.data.profile !== undefined) {
      const parsed = parseFaultProfile(body.data.profile, 'proxy');
      if (!parsed.ok) return fail(reply, 400, 'tokenfault_invalid_request', parsed.error);
      selection = { scenarioId: null, profile: parsed.value };
    } else {
      return fail(
        reply,
        400,
        'tokenfault_invalid_request',
        'Provide either scenarioId or profile.',
      );
    }
    ctx.setActive(selection);
    return { activeFaults: toActiveFaults(selection) };
  });

  app.delete(`${API_PREFIX}/faults`, (_request, reply) => {
    ctx.setActive(null);
    return reply.code(204).send();
  });

  app.post(`${API_PREFIX}/replays`, (request, reply) => {
    const json = parseJson(request.body);
    if (!json.ok) return fail(reply, 400, 'tokenfault_invalid_request', json.error);
    const body = ReplayBodySchema.safeParse(json.value);
    if (!body.success)
      return fail(reply, 400, 'tokenfault_invalid_request', z.prettifyError(body.error));
    const timing: ReplayTiming = body.data.timing ?? { kind: 'original' };
    const timingError = validateTiming(timing);
    if (timingError) return fail(reply, 400, 'tokenfault_invalid_request', timingError);

    let recording: Recording;
    let replayOf: string | null = null;
    if (body.data.sessionId !== undefined) {
      const session = ctx.store.get(body.data.sessionId);
      if (!session)
        return fail(
          reply,
          404,
          'tokenfault_not_found',
          'Session not found (it may have been evicted).',
        );
      if (!session.ended)
        return fail(reply, 409, 'tokenfault_invalid_request', 'Session is still streaming.');
      // In-memory replay may use captured payloads: they never leave this process.
      recording = createRecording(session.detail(), {
        includePayloads: true,
        toolVersion: ctx.version,
        seed: session.seed,
      });
      replayOf = session.id;
    } else if (body.data.recording !== undefined) {
      const validated = validateRecording(body.data.recording);
      if (!validated.ok) return fail(reply, 400, 'tokenfault_invalid_request', validated.error);
      recording = validated.recording;
    } else {
      return fail(
        reply,
        400,
        'tokenfault_invalid_request',
        'Provide either sessionId or recording.',
      );
    }
    try {
      const started = ctx.replays.start(recording, timing, replayOf);
      const response: ReplayResponse = { sessionId: started.sessionId, mode: started.mode };
      return reply.code(202).send(response);
    } catch (error) {
      if (error instanceof ReplayLimitError)
        return fail(reply, 429, 'tokenfault_invalid_request', error.message);
      throw error;
    }
  });

  app.post(`${API_PREFIX}/probe`, async (request, reply) => {
    const json = parseJson(request.body);
    if (!json.ok) return fail(reply, 400, 'tokenfault_invalid_request', json.error);
    const body = ProbeBodySchema.safeParse(json.value);
    if (!body.success)
      return fail(reply, 400, 'tokenfault_invalid_request', z.prettifyError(body.error));
    if (
      body.data.scenarioId !== undefined &&
      body.data.scenarioId !== 'none' &&
      !findScenario(body.data.scenarioId)
    ) {
      return fail(
        reply,
        400,
        'tokenfault_invalid_request',
        `Unknown scenario "${body.data.scenarioId}"`,
      );
    }
    const origin = ctx.selfOrigin();
    if (!origin) return fail(reply, 503, 'tokenfault_internal', 'Server is not listening yet.');
    const result = await sendProbe(origin, ctx.targetBasePath, body.data);
    return result;
  });
}

/**
 * Sends a sample streaming chat completion through this proxy's own data
 * path, exactly like an application would. Resolves once response headers
 * arrive (with the session id). The body keeps streaming in the background so
 * the session can be watched live in Studio.
 */
function sendProbe(
  origin: string,
  basePath: string,
  options: z.infer<typeof ProbeBodySchema>,
): Promise<ProbeResponse> {
  const path = basePath.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
  const payload = Buffer.from(
    JSON.stringify({
      model: options.model ?? 'tokenfault-mock-1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: options.prompt ?? 'Hello from the TokenFault Studio probe.' },
      ],
      ...(options.withTools
        ? {
            tools: [
              {
                type: 'function',
                function: {
                  name: 'get_weather',
                  parameters: {
                    type: 'object',
                    properties: {
                      location: { type: 'string' },
                      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    }),
  );
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': payload.length,
    accept: 'text/event-stream',
  };
  if (options.scenarioId !== undefined) headers[SCENARIO_HEADER] = options.scenarioId;

  return new Promise((resolve) => {
    const req = httpRequest(`${origin}${path}`, { method: 'POST', headers, timeout: 120_000 });
    req.on('response', (res) => {
      const sessionHeader = res.headers[SESSION_HEADER];
      resolve({
        sessionId: typeof sessionHeader === 'string' ? sessionHeader : null,
        status: res.statusCode ?? null,
        error: null,
      });
      // Drain the body so the stream runs to completion; errors are expected for fault scenarios.
      res.on('error', () => undefined);
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('probe timed out')));
    req.on('error', (error) => resolve({ sessionId: null, status: null, error: error.message }));
    req.end(payload);
  });
}
