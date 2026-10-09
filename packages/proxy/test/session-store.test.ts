import { describe, expect, it, vi } from 'vitest';
import type { LiveMessage } from '@tokenfault/shared';
import { SessionStore } from '../src/session-store.js';
import type { SessionMeta } from '@tokenfault/core';

const limits = {
  maxEventBytes: 1024,
  maxEventsPerSession: 100,
  maxChunksPerSession: 100,
  maxCapturedBytesPerSession: 10_000,
};
const meta = (id: string): SessionMeta => ({
  id,
  source: 'proxy',
  startedAt: '2026-10-09T00:00:00.000Z',
  method: 'POST',
  path: '/v1/chat/completions',
  scenarioId: null,
  faults: [],
  request: { model: null, stream: true, messageCount: 1, toolCount: null, bodyBytes: 10 },
  replayOf: null,
});
const enc = new TextEncoder();

describe('SessionStore', () => {
  it('evicts the oldest sessions beyond maxSessions', () => {
    const store = new SessionStore({ maxSessions: 2, capturePayloads: true, limits });
    store.create(meta('a'), null);
    store.create(meta('b'), null);
    store.create(meta('c'), null);
    expect(store.list().map((s) => s.id)).toEqual(['c', 'b']);
    expect(store.get('a')).toBeUndefined();
  });

  it('batches progress notifications and flushes on end', async () => {
    vi.useFakeTimers();
    try {
      const store = new SessionStore({
        maxSessions: 10,
        capturePayloads: true,
        limits,
        flushIntervalMs: 50,
      });
      const messages: LiveMessage[] = [];
      store.subscribe((m) => messages.push(m));
      const s = store.create(meta('x'), null);
      store.onHeaders(s, 200, { 'content-type': 'text/event-stream' }, 1);
      store.recordChunk(s, enc.encode('data: {"choices":[]}\n\n'), 2);
      store.recordChunk(s, enc.encode('data: [DONE]\n\n'), 3);
      expect(messages.map((m) => m.type)).toEqual(['session-started']);
      await vi.advanceTimersByTimeAsync(60);
      const progress = messages.filter((m) => m.type === 'session-progress');
      expect(progress).toHaveLength(1);
      expect(progress[0]!.type === 'session-progress' && progress[0]!.events).toHaveLength(2);
      store.end(s, { kind: 'eof', atMs: 4, detail: null });
      store.end(s, { kind: 'eof', atMs: 5, detail: null });
      expect(messages.filter((m) => m.type === 'session-ended')).toHaveLength(1);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a subscriber that throws and keeps serving others', () => {
    const store = new SessionStore({ maxSessions: 10, capturePayloads: true, limits });
    const good: string[] = [];
    store.subscribe(() => {
      throw new Error('broken subscriber');
    });
    store.subscribe((m) => good.push(m.type));
    store.create(meta('a'), null);
    store.create(meta('b'), null);
    expect(good).toEqual(['session-started', 'session-started']);
  });

  it('notifies end listeners only for retained sessions', () => {
    const store = new SessionStore({ maxSessions: 1, capturePayloads: true, limits });
    const ended: string[] = [];
    store.onSessionEnd((s) => ended.push(s.id));
    const a = store.create(meta('a'), null);
    const b = store.create(meta('b'), null);
    store.end(a, { kind: 'eof', atMs: 1, detail: null });
    store.end(b, { kind: 'eof', atMs: 1, detail: null });
    expect(ended).toEqual(['b']);
  });
});
