/** Regression tests for defects found in the internal adversarial review. */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '@tokenfault/shared';
import { StreamInspector } from '../src/inspector/stream-inspector.js';
import { sessionDetail } from '../src/inspector/session.js';
import {
  createRecording,
  serializeRecording,
  validateRecording,
} from '../src/recording/recording.js';
import { createReplayPlan } from '../src/replay/plan.js';
import { sleep } from '../src/faults/executor.js';
import { endResponse, terminateResponse } from '../src/node/response.js';

const enc = new TextEncoder();

function hostileSession(): SessionDetail {
  const insp = new StreamInspector();
  insp.onHeaders(999, { 'content-type': 'text/event-stream', 'x-request-id': 'r'.repeat(5000) }, 1);
  insp.onChunk(
    enc.encode(`event: ${'e'.repeat(300)}\nid: ${'i'.repeat(2000)}\ndata: {"choices":[]}\n\n`),
    2,
  );
  insp.onEnd({ kind: 'eof', atMs: 3, detail: 'd'.repeat(5000) });
  return sessionDetail(
    {
      id: 'hostile',
      source: 'proxy',
      startedAt: '2026-10-09T00:00:00.000Z',
      method: 'POST',
      path: `/v1/${'p'.repeat(3000)}`,
      scenarioId: null,
      faults: [],
      request: { model: 'm', stream: true, messageCount: 1, toolCount: null, bodyBytes: 1 },
      replayOf: null,
    },
    insp,
    [],
  );
}

describe('recordings tolerate hostile upstream data', () => {
  it('creates a valid, replayable recording when upstream values exceed schema bounds', () => {
    for (const includePayloads of [false, true]) {
      const rec = createRecording(hostileSession(), {
        toolVersion: '0',
        seed: null,
        includePayloads,
      });
      expect(validateRecording(JSON.parse(serializeRecording(rec))).ok).toBe(true);
      expect(rec.session.status).toBe(999);
      expect(rec.session.path.length).toBeLessThanOrEqual(2048);
      expect(() => createReplayPlan(rec)).not.toThrow();
    }
  });
});

interface MutableRecording {
  events: { event: string; id: string | null }[];
  chunks: { dataBase64: string; byteLength: number }[];
}

describe('recordings that validate can be replayed', () => {
  const base = JSON.parse(
    serializeRecording(
      createRecording(hostileSession(), { toolVersion: '0', seed: null, includePayloads: true }),
    ),
  ) as MutableRecording;

  it.each([
    [
      'event with a line break',
      (r: MutableRecording) => {
        r.events[0]!.event = 'a\nb';
      },
    ],
    [
      'id with U+0000',
      (r: MutableRecording) => {
        r.events[0]!.id = 'a\u0000b';
      },
    ],
    [
      'invalid base64',
      (r: MutableRecording) => {
        r.chunks[0]!.dataBase64 = '!!!!';
      },
    ],
    [
      'mismatched byteLength',
      (r: MutableRecording) => {
        r.chunks[0]!.byteLength += 1;
      },
    ],
  ])('rejects %s at validation time', (_name, mutate) => {
    const copy = structuredClone(base);
    mutate(copy);
    expect(validateRecording(copy).ok).toBe(false);
  });
});

describe('sleep handles delays beyond the timer limit', () => {
  afterEach(() => vi.useRealTimers());

  it('does not fire early for delays above 2^31-1 ms', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = sleep(3_000_000_000).then((v) => {
      done = v;
    });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000_000_000 - 2_147_483_647);
    await pending;
    expect(done).toBe(true);
  });
});

describe('endResponse', () => {
  it('resolves even if the client socket was destroyed before the response ended', async () => {
    let resolved = false;
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.write('partial');
      res.socket?.destroy();
      void endResponse(res).then(() => {
        resolved = true;
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((r) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.on('error', () => r());
        res.on('close', () => r());
        res.resume();
      });
      req.on('error', () => r());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    expect(resolved).toBe(true);
  });
});

describe('terminateResponse reset (XP-10)', () => {
  /**
   * A socket with bytes still queued below the high-water mark: 'drain' never fires, which
   * is what Windows CI showed (509 bytes queued, RST only after the 1 s fallback).
   */
  function queuedSocket() {
    const socket = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      writableLength: number;
      writableNeedDrain: boolean;
      write: (chunk: Uint8Array, cb: () => void) => boolean;
      resetAndDestroy: () => void;
      resetAt: number | null;
    };
    socket.destroyed = false;
    socket.writableLength = 509;
    socket.writableNeedDrain = false;
    socket.resetAt = null;
    socket.write = (_chunk, cb) => {
      // The OS accepts the queued bytes shortly; callbacks run in order after that.
      setTimeout(() => {
        socket.writableLength = 0;
        cb();
      }, 5);
      return true;
    };
    socket.resetAndDestroy = () => {
      socket.resetAt = performance.now();
      socket.destroyed = true;
    };
    return socket;
  }

  it('sends the RST once queued bytes are flushed, without waiting for a drain that never comes', async () => {
    const socket = queuedSocket();
    const res = { destroyed: false, socket } as unknown as ServerResponse;
    const started = performance.now();
    terminateResponse(res, 'reset');
    await new Promise((r) => setTimeout(r, 200));
    expect(socket.resetAt).not.toBeNull();
    // 15 ms grace on Windows plus timer slack; the old code waited for the 1 s fallback.
    expect(socket.resetAt! - started).toBeLessThan(150);
  });
});
