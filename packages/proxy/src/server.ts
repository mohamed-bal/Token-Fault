/**
 * TokenFault server: proxy data path + control API + Studio host, in one
 * Fastify instance on one port.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { findScenario, parseFaultProfile } from '@tokenfault/core';
import type { FaultProfileInput, FaultSelection } from '@tokenfault/core';
import { isLoopbackAddress, isLoopbackBindHost, isLoopbackHostHeader } from '@tokenfault/core/node';
import {
  CONTROL_PREFIX,
  DEFAULT_LIMITS,
  DEFAULT_PROXY_PORT,
  STUDIO_PREFIX,
  errorBody,
  redactPathQuery,
} from '@tokenfault/shared';
import type { Limits } from '@tokenfault/shared';
import { registerControlApi, toActiveFaults } from './control-api.js';
import { handleProxyRequest } from './proxy-handler.js';
import { SessionRecorder } from './recorder.js';
import { ReplayManager } from './replay.js';
import { SessionStore } from './session-store.js';
import { StaticRoot, openStaticFile } from './static-files.js';
import { parseTarget } from './target.js';

export interface TokenFaultServerOptions {
  /** Upstream base URL (fixed for the server's lifetime). */
  readonly target: string;
  readonly host?: string;
  readonly port?: number;
  /** Required to bind a non-loopback address. The control API stays loopback-only regardless. */
  readonly allowRemote?: boolean;
  /** Keep response payloads in memory for inspection. Default `true`. */
  readonly capturePayloads?: boolean;
  readonly headersTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number | null;
  /** Initially active scenario (proxy-applicable). */
  readonly scenarioId?: string | null;
  /** Initially active fault profile (ignored if `scenarioId` is set). */
  readonly faults?: FaultProfileInput | null;
  /** Directory for automatic session recordings. Disabled when unset. */
  readonly recordDir?: string | null;
  readonly recordPayloads?: boolean;
  readonly recordMaxFiles?: number;
  readonly recordMaxAgeDays?: number;
  /** Directory of the built Studio bundle. Studio is disabled when unset. */
  readonly studioDir?: string | null;
  readonly limits?: Partial<Limits>;
  readonly logger?: boolean;
  readonly version?: string;
}

const OptionsSchema = z.strictObject({
  target: z.string().min(1).max(2_048),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  allowRemote: z.boolean().optional(),
  capturePayloads: z.boolean().optional(),
  headersTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  idleTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  totalTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(24 * 3_600_000)
    .nullable()
    .optional(),
  scenarioId: z.string().max(128).nullable().optional(),
  faults: z.unknown().optional(),
  recordDir: z.string().min(1).max(4_096).nullable().optional(),
  recordPayloads: z.boolean().optional(),
  recordMaxFiles: z.number().int().min(1).max(100_000).optional(),
  recordMaxAgeDays: z.number().int().min(1).max(3_650).optional(),
  studioDir: z.string().min(1).max(4_096).nullable().optional(),
  limits: z
    .strictObject({
      maxEventBytes: z
        .number()
        .int()
        .min(1_024)
        .max(64 * 1024 * 1024)
        .optional(),
      maxRequestBodyBytes: z
        .number()
        .int()
        .min(1_024)
        .max(512 * 1024 * 1024)
        .optional(),
      maxSessions: z.number().int().min(1).max(100_000).optional(),
      maxEventsPerSession: z.number().int().min(1).max(10_000_000).optional(),
      maxChunksPerSession: z.number().int().min(1).max(10_000_000).optional(),
      maxCapturedBytesPerSession: z
        .number()
        .int()
        .min(0)
        .max(1024 * 1024 * 1024)
        .optional(),
      maxRecordingBytes: z
        .number()
        .int()
        .min(1_024)
        .max(1024 * 1024 * 1024)
        .optional(),
      maxSubscriberBufferBytes: z
        .number()
        .int()
        .min(1_024)
        .max(1024 * 1024 * 1024)
        .optional(),
      maxFaultHeaderBytes: z
        .number()
        .int()
        .min(64)
        .max(64 * 1024)
        .optional(),
    })
    .optional(),
  logger: z.boolean().optional(),
  version: z.string().max(64).optional(),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface TokenFaultServer {
  readonly app: FastifyInstance;
  readonly store: SessionStore;
  /** Starts listening and resolves with the base URL. */
  listen(): Promise<string>;
  /** Stops accepting connections, aborts replays and flushes pending recordings. */
  close(): Promise<void>;
  readonly url: string | null;
  /** Credential-free display form of the upstream target. */
  readonly targetDisplay: string;
  setActiveFaults(selection: FaultSelection | null): void;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
} as const;

const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

function resolveInitialFaults(options: TokenFaultServerOptions): FaultSelection | null {
  if (options.scenarioId) {
    const scenario = findScenario(options.scenarioId);
    if (!scenario) throw new ConfigError(`Unknown scenario "${options.scenarioId}"`);
    if (!scenario.descriptor.appliesTo.includes('proxy')) {
      throw new ConfigError(
        `Scenario "${options.scenarioId}" can only be applied by the mock server`,
      );
    }
    return { scenarioId: scenario.descriptor.id, profile: scenario.profile };
  }
  if (options.faults) {
    const parsed = parseFaultProfile(options.faults, 'proxy');
    if (!parsed.ok) throw new ConfigError(`Invalid fault profile: ${parsed.error}`);
    return { scenarioId: null, profile: parsed.value };
  }
  return null;
}

function isControlPath(url: string): boolean {
  return (
    url === CONTROL_PREFIX ||
    url.startsWith(`${CONTROL_PREFIX}/`) ||
    url.startsWith(`${CONTROL_PREFIX}?`)
  );
}

function isAllowedOrigin(origin: string, port: number | null): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (!isLoopbackHostHeader(parsed.host)) return false;
  return port === null || Number(parsed.port || '80') === port;
}

export function createTokenFaultServer(options: TokenFaultServerOptions): TokenFaultServer {
  const checked = OptionsSchema.safeParse(options);
  if (!checked.success)
    throw new ConfigError(`Invalid server options:\n${z.prettifyError(checked.error)}`);
  const target = (() => {
    try {
      return parseTarget(options.target);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
  })();
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackBindHost(host) && options.allowRemote !== true) {
    throw new ConfigError(
      `Refusing to bind ${host}: this exposes the proxy to the network. Pass allowRemote (CLI: --allow-remote) if that is intended.`,
    );
  }
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const version = options.version ?? '0.1.0';
  let active = resolveInitialFaults(options);

  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          serializers: {
            req: (req: FastifyRequest) => ({
              id: req.id,
              method: req.method,
              url: redactPathQuery(req.url),
            }),
          },
        }
      : false,
    bodyLimit: limits.maxRequestBodyBytes,
    genReqId: () => randomUUID(),
    forceCloseConnections: true,
    // Headers timeout and keep-alive are handled per exchange; long streams must not be cut by Node defaults.
    requestTimeout: 0,
  });

  const store = new SessionStore({
    maxSessions: limits.maxSessions,
    capturePayloads: options.capturePayloads ?? true,
    limits: {
      maxEventBytes: limits.maxEventBytes,
      maxEventsPerSession: limits.maxEventsPerSession,
      maxChunksPerSession: limits.maxChunksPerSession,
      maxCapturedBytesPerSession: limits.maxCapturedBytesPerSession,
    },
  });
  const replays = new ReplayManager(store);
  const recorder = options.recordDir
    ? new SessionRecorder({
        dir: options.recordDir,
        includePayloads: options.recordPayloads ?? false,
        maxFiles: options.recordMaxFiles ?? 100,
        maxAgeDays: options.recordMaxAgeDays ?? 14,
        toolVersion: version,
        logger: app.log,
      })
    : null;
  if (recorder) {
    store.onSessionEnd((session) => {
      if (session.meta.source === 'proxy') void recorder.record(session);
    });
  }

  let listeningUrl: string | null = null;
  let listeningPort: number | null = null;

  // All bodies are taken as raw buffers: the proxy forwards them byte-for-byte,
  // and the control API parses JSON explicitly.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url ?? '';
    if (!isControlPath(url)) return;
    void reply.headers(SECURITY_HEADERS);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply
        .code(403)
        .send(
          errorBody(
            'tokenfault_forbidden',
            'The TokenFault control plane only accepts loopback connections.',
          ),
        );
    }
    if (!isLoopbackHostHeader(request.headers.host)) {
      return reply
        .code(403)
        .send(
          errorBody(
            'tokenfault_forbidden',
            'Host header must name a loopback host (DNS-rebinding protection).',
          ),
        );
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      return reply
        .code(403)
        .send(errorBody('tokenfault_forbidden', 'Cross-site requests are not allowed.'));
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin !== undefined && !isAllowedOrigin(origin, listeningPort)) {
        return reply.code(403).send(errorBody('tokenfault_forbidden', 'Origin is not allowed.'));
      }
      const length = Number(request.headers['content-length'] ?? '0');
      const contentType = (request.headers['content-type'] ?? '').toLowerCase();
      if (
        (length > 0 || request.headers['transfer-encoding'] !== undefined) &&
        !contentType.startsWith('application/json')
      ) {
        return reply
          .code(415)
          .send(
            errorBody(
              'tokenfault_invalid_request',
              'Control API requests must use application/json.',
            ),
          );
      }
    }
    return undefined;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) {
      return reply
        .code(413)
        .send(
          errorBody(
            'tokenfault_payload_too_large',
            `Request body exceeds ${limits.maxRequestBodyBytes} bytes.`,
          ),
        );
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send(errorBody('tokenfault_invalid_request', error.message));
    }
    request.log.error({ err: error.message }, 'unhandled error');
    return reply.code(500).send(errorBody('tokenfault_internal', 'Internal error.'));
  });

  registerControlApi(app, {
    store,
    replays,
    limits,
    version,
    targetDisplay: target.display,
    targetBasePath: target.basePath,
    recording: { enabled: recorder !== null, includePayloads: options.recordPayloads ?? false },
    getActive: () => active,
    setActive: (selection) => {
      active = selection;
      store.announceFaults(toActiveFaults(selection));
    },
    selfOrigin: () => listeningUrl,
  });

  if (options.studioDir) {
    const studio = new StaticRoot(options.studioDir);
    app.get(`${STUDIO_PREFIX}/*`, async (request, reply) => {
      const wildcard = (request.params as { '*'?: string })['*'] ?? '';
      const found = await studio.lookup(wildcard);
      if (!found.ok)
        return reply.code(found.status).send(errorBody('tokenfault_not_found', 'Not found.'));
      const file = found.file;
      void reply.header('content-type', file.contentType).header('content-length', file.size);
      void reply.header(
        'cache-control',
        file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      if (file.contentType.startsWith('text/html'))
        void reply.header('content-security-policy', STUDIO_CSP);
      return reply.send(openStaticFile(file));
    });
    app.get(STUDIO_PREFIX, (_request, reply) => reply.redirect(`${STUDIO_PREFIX}/`, 302));
    app.get('/', (request, reply) => {
      if (
        (request.headers.accept ?? '').includes('text/html') &&
        isLoopbackHostHeader(request.headers.host)
      ) {
        return reply.redirect(`${STUDIO_PREFIX}/`, 302);
      }
      return handleProxyRequest(proxyContext, request, reply);
    });
  } else {
    app.get(STUDIO_PREFIX, (_request, reply) =>
      reply
        .code(404)
        .send(
          errorBody(
            'tokenfault_not_found',
            'Studio assets are not available in this build. Run `pnpm build` and restart.',
          ),
        ),
    );
  }

  const proxyContext = {
    target,
    store,
    limits,
    headersTimeoutMs: options.headersTimeoutMs ?? 60_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
    totalTimeoutMs: options.totalTimeoutMs ?? null,
    activeFaults: () => active,
    logger: app.log,
  };

  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    url: '/*',
    handler: (request, reply) => handleProxyRequest(proxyContext, request, reply),
  });

  return {
    app,
    store,
    get url() {
      return listeningUrl;
    },
    targetDisplay: target.display,
    async listen() {
      await app.listen({ host, port: options.port ?? DEFAULT_PROXY_PORT });
      const address = app.server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Server did not bind to a TCP port');
      listeningPort = address.port;
      const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      // The probe and the printed URL use a loopback address even when bound to 0.0.0.0.
      const reachableHost = isLoopbackBindHost(address.address) ? hostPart : '127.0.0.1';
      listeningUrl = `http://${reachableHost}:${address.port}`;
      return listeningUrl;
    },
    async close() {
      replays.abortAll();
      await app.close();
      store.dispose();
      if (recorder) await recorder.flush();
    },
    setActiveFaults(selection) {
      active = selection;
      store.announceFaults(toActiveFaults(selection));
    },
  };
}
