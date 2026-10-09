/**
 * Replays recordings into the session store, so Studio can watch a recorded
 * stream unfold live, and serves recordings over HTTP for client applications.
 * Neither path contacts any model.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { createReplayPlan, runReplay } from '@tokenfault/core';
import type { Recording, ReplayPlan } from '@tokenfault/core';
import { terminateResponse, writeWithBackpressure } from '@tokenfault/core/node';
import { SESSION_HEADER, describeError } from '@tokenfault/shared';
import type { ReplayTiming, TerminationKind } from '@tokenfault/shared';
import type { SessionStore } from './session-store.js';

export class ReplayLimitError extends Error {}

/** Maps a transformed annotation time for the selected timing. */
function annotationTime(
  atMs: number,
  afterEvents: number | null,
  timing: ReplayTiming,
  plan: ReplayPlan,
): number {
  switch (timing.kind) {
    case 'original':
      return atMs;
    case 'scaled':
      return atMs / timing.factor;
    case 'fixed':
      return plan.steps[Math.min(afterEvents ?? 0, Math.max(0, plan.steps.length - 1))]?.atMs ?? 0;
  }
}

export class ReplayManager {
  private readonly running = new Set<AbortController>();

  constructor(
    private readonly store: SessionStore,
    private readonly maxConcurrent = 4,
  ) {}

  get active(): number {
    return this.running.size;
  }

  /** Starts a replay in the background and returns the new session id immediately. */
  start(
    recording: Recording,
    timing: ReplayTiming,
    replayOf: string | null,
  ): { sessionId: string; mode: ReplayPlan['mode'] } {
    if (this.running.size >= this.maxConcurrent) {
      throw new ReplayLimitError(`At most ${this.maxConcurrent} replays can run at the same time.`);
    }
    const plan = createReplayPlan(recording, timing);
    const src = recording.session;
    const session = this.store.create(
      {
        id: randomUUID(),
        source: 'replay',
        startedAt: new Date().toISOString(),
        method: src.method,
        path: src.path,
        scenarioId: src.scenarioId,
        faults: src.faults,
        request: src.request,
        replayOf: replayOf ?? src.id,
      },
      src.seed,
    );
    for (const a of recording.annotations) {
      this.store.annotate(session, {
        ...a,
        atMs: annotationTime(a.atMs, a.afterEvents, timing, plan),
        message: `[replayed] ${a.message}`,
      });
    }

    const controller = new AbortController();
    this.running.add(controller);
    const started = performance.now();
    const now = (): number => performance.now() - started;
    const originalKind: TerminationKind = src.termination?.kind ?? 'replay-end';

    void runReplay(
      plan,
      {
        start: (status, headers) => void this.store.onHeaders(session, status, headers, now()),
        write: (bytes) => {
          this.store.recordChunk(session, bytes, now());
          return Promise.resolve();
        },
        finish: (mode) =>
          this.store.end(session, {
            kind: mode === 'end' ? 'replay-end' : originalKind,
            atMs: now(),
            detail: mode === 'end' ? null : `replayed termination (mode=${mode})`,
          }),
      },
      controller.signal,
    )
      .then((result) => {
        if (result === 'aborted')
          this.store.end(session, {
            kind: 'client-abort',
            atMs: now(),
            detail: 'replay cancelled',
          });
      })
      .catch((error: unknown) =>
        this.store.end(session, { kind: 'proxy-error', atMs: now(), detail: describeError(error) }),
      )
      .finally(() => this.running.delete(controller));

    return { sessionId: session.id, mode: plan.mode };
  }

  abortAll(): void {
    for (const c of this.running) c.abort();
  }
}

export interface ReplayServerOptions {
  readonly recording: Recording;
  readonly timing?: ReplayTiming;
  readonly host?: string;
  readonly port?: number;
}

export interface RunningReplayServer {
  readonly url: string;
  readonly app: FastifyInstance;
  readonly plan: ReplayPlan;
  close(): Promise<void>;
}

/**
 * Serves a recording to client applications: every `POST` to the recorded path
 * (and to `/v1/chat/completions`) replays the recorded response from the start.
 */
export async function startReplayServer(
  options: ReplayServerOptions,
): Promise<RunningReplayServer> {
  const timing = options.timing ?? { kind: 'original' };
  const plan = createReplayPlan(options.recording, timing);
  const app = Fastify({ logger: false, forceCloseConnections: true, bodyLimit: 20 * 1024 * 1024 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.get('/healthz', () => ({ status: 'ok' }));

  const paths = new Set(['/v1/chat/completions']);
  const recordedPath = options.recording.session.path.split('?')[0] ?? '';
  // Only plain paths are registered; anything that could be a route pattern is ignored.
  if (/^\/[A-Za-z0-9._~/-]{0,512}$/.test(recordedPath)) paths.add(recordedPath);
  for (const p of paths) {
    app.post(p, async (_request, reply) => {
      reply.hijack();
      const res = reply.raw;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        await runReplay(
          plan,
          {
            start: (status, headers) => {
              res.writeHead(status, {
                ...headers,
                [SESSION_HEADER]: options.recording.session.id,
                'x-tokenfault-replay': plan.mode,
              });
              res.flushHeaders();
              res.socket?.setNoDelay(true);
            },
            write: (bytes) => writeWithBackpressure(res, bytes),
            finish: (mode) => terminateResponse(res, mode),
          },
          controller.signal,
        );
      } catch {
        if (!res.destroyed) res.destroy();
      }
    });
  }

  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Replay server did not bind to a TCP port');
  const hostPart = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return { url: `http://${hostPart}:${address.port}`, app, plan, close: () => app.close() };
}
