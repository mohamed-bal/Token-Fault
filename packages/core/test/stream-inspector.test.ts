import { describe, expect, it } from 'vitest';
import { StreamInspector } from '../src/inspector/stream-inspector.js';
import { computeGapStats } from '../src/metrics/gaps.js';
import { base64ToBytes, bytesToBase64 } from '../src/util/base64.js';

const enc = new TextEncoder();
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  authorization: 'Bearer sk-secret',
};

const ev = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

describe('StreamInspector', () => {
  it('captures chunks, events and exact timing metrics', () => {
    const insp = new StreamInspector();
    insp.onHeaders(200, SSE_HEADERS, 10);
    insp.onChunk(
      enc.encode(
        `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n`,
      ),
      15,
    );
    insp.onChunk(enc.encode(ev('Hel').slice(0, 20)), 30);
    insp.onChunk(enc.encode(ev('Hel').slice(20)), 31);
    insp.onChunk(enc.encode(ev('lo', 'stop') + 'data: [DONE]\n\n'), 50);
    insp.onEnd({ kind: 'eof', atMs: 55, detail: null });

    const snap = insp.snapshot();
    expect(snap.outcome).toBe('completed');
    expect(snap.completionSignal).toBe('done-marker');
    expect(snap.responseHeaders).toEqual({ 'content-type': 'text/event-stream; charset=utf-8' });
    expect(snap.metrics).toMatchObject({
      headersMs: 10,
      firstByteMs: 15,
      firstEventMs: 15,
      firstContentMs: 31,
      durationMs: 55,
      eventCount: 4,
      chunkCount: 4,
      contentDeltaCount: 2,
      usage: null,
    });
    expect(snap.metrics.eventGaps).toEqual({
      count: 3,
      minMs: 0,
      maxMs: 19,
      meanMs: 11.667,
      p50Ms: 16,
      p95Ms: 19,
      p99Ms: 19,
    });
    expect(snap.choices[0]?.content).toBe('Hello');
    expect(insp.events.map((e) => e.interpretation.kind)).toEqual([
      'chunk',
      'chunk',
      'chunk',
      'done',
    ]);
    expect(insp.events[1]?.atMs).toBe(31);
    expect(insp.chunks).toHaveLength(4);
    expect(new TextDecoder().decode(base64ToBytes(insp.chunks[3]!.dataBase64!))).toContain(
      '[DONE]',
    );
  });

  it('marks a stream that ends without terminator as incomplete', () => {
    const insp = new StreamInspector();
    insp.onHeaders(200, SSE_HEADERS, 1);
    insp.onChunk(enc.encode(ev('partial')), 2);
    insp.onEnd({ kind: 'upstream-reset', atMs: 3, detail: 'ECONNRESET' });
    const snap = insp.snapshot();
    expect(snap.outcome).toBe('incomplete');
    expect(insp.diagnostics.map((d) => d.code)).toContain('chat-missing-terminator');
  });

  it('reports http errors without decoding', () => {
    const insp = new StreamInspector();
    insp.onHeaders(429, { 'content-type': 'application/json', 'retry-after': '2' }, 1);
    insp.onChunk(enc.encode('{"error":{"message":"slow down"}}'), 2);
    insp.onEnd({ kind: 'eof', atMs: 3, detail: null });
    expect(insp.snapshot()).toMatchObject({
      outcome: 'http-error',
      status: 429,
      responseHeaders: { 'retry-after': '2' },
    });
    expect(insp.events).toHaveLength(0);
  });

  it('reports non-streaming JSON responses', () => {
    const insp = new StreamInspector();
    insp.onHeaders(200, { 'content-type': 'application/json' }, 1);
    insp.onChunk(enc.encode('{}'), 2);
    insp.onEnd({ kind: 'eof', atMs: 3, detail: null });
    expect(insp.snapshot().outcome).toBe('non-stream');
  });

  it('does not decode compressed bodies', () => {
    const insp = new StreamInspector();
    insp.onHeaders(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }, 1);
    insp.onChunk(new Uint8Array([0x1f, 0x8b, 0, 1]), 2);
    insp.onEnd({ kind: 'eof', atMs: 3, detail: null });
    expect(insp.diagnostics.map((d) => d.code)).toEqual(['transport-compressed-body']);
    expect(insp.snapshot().outcome).toBe('incomplete');
  });

  it('redacts payloads when capture is disabled but keeps metrics', () => {
    const insp = new StreamInspector({ capturePayloads: false });
    insp.onHeaders(200, SSE_HEADERS, 1);
    insp.onChunk(enc.encode(ev('secret', 'stop') + 'data: [DONE]\n\n'), 2);
    insp.onEnd({ kind: 'eof', atMs: 3, detail: null });
    expect(insp.events[0]).toMatchObject({
      data: null,
      interpretation: { content: null, contentLength: 6 },
    });
    expect(insp.chunks[0]?.dataBase64).toBeNull();
    expect(insp.snapshot().choices[0]?.content).toBeNull();
    expect(insp.snapshot().metrics.contentDeltaCount).toBe(1);
  });

  it('enforces capture limits but keeps counting', () => {
    const insp = new StreamInspector({
      limits: {
        maxEventsPerSession: 2,
        maxChunksPerSession: 1,
        maxCapturedBytesPerSession: 1_000_000,
      },
    });
    insp.onHeaders(200, SSE_HEADERS, 0);
    for (let i = 0; i < 5; i++) insp.onChunk(enc.encode(ev(String(i))), i + 1);
    insp.onEnd({ kind: 'eof', atMs: 10, detail: null });
    const snap = insp.snapshot();
    expect(insp.events).toHaveLength(2);
    expect(insp.chunks).toHaveLength(1);
    expect(snap).toMatchObject({ truncated: true, droppedEvents: 3, droppedChunks: 4 });
    expect(snap.metrics.eventCount).toBe(5);
  });

  it('is idempotent on end and rejects chunks after end', () => {
    const insp = new StreamInspector();
    insp.onHeaders(200, SSE_HEADERS, 0);
    insp.onEnd({ kind: 'client-abort', atMs: 1, detail: null });
    insp.onEnd({ kind: 'eof', atMs: 2, detail: null });
    expect(insp.snapshot().termination?.kind).toBe('client-abort');
    expect(() => insp.onChunk(enc.encode('x'), 3)).toThrow();
  });

  it('records reported usage', () => {
    const insp = new StreamInspector();
    insp.onHeaders(200, SSE_HEADERS, 0);
    insp.onChunk(
      enc.encode(
        `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n`,
      ),
      1,
    );
    expect(insp.metrics().usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });
});

describe('gap stats and base64', () => {
  it('computes nearest-rank percentiles', () => {
    const gaps = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(computeGapStats(gaps)).toEqual({
      count: 100,
      minMs: 1,
      maxMs: 100,
      meanMs: 50.5,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
    });
    expect(computeGapStats([])).toBeNull();
  });

  it('round-trips base64 and rejects malformed input', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(() => base64ToBytes('abc')).toThrow(TypeError);
    expect(() => base64ToBytes('ab!d')).toThrow(TypeError);
  });
});

describe('base64 fast path', () => {
  it('matches the portable encoder for arbitrary bytes and offsets', async () => {
    const { bytesToBase64, bytesToBase64Portable, base64ToBytes } =
      await import('../src/util/base64.js');
    const big = new Uint8Array(100_003).map((_, i) => (i * 7919) % 256);
    for (const view of [big, big.subarray(1), big.subarray(5, 9), big.subarray(0, 0)]) {
      expect(bytesToBase64(view)).toBe(bytesToBase64Portable(view));
      expect(base64ToBytes(bytesToBase64(view))).toEqual(view);
    }
  });
});
