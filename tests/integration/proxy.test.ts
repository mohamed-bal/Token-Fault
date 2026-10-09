import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, createTokenFaultServer } from '@tokenfault/proxy';
import {
  ControlClient,
  startProxy,
  startStack,
  streamChatCompletion,
  streamRequest,
  waitForSession,
} from '@tokenfault/testing';
import type { RunningProxy, Stack } from '@tokenfault/testing';
import { closedPort, sleep, sseChunk, startUpstream } from './helpers.js';
import type { TestUpstream } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function proxyTo(
  upstream: TestUpstream,
  options: Parameters<typeof startProxy>[0] extends infer O ? Partial<O> : never = {},
) {
  const proxy = await startProxy({ target: upstream.url, ...options });
  cleanups.push(() => proxy.close());
  return proxy;
}

async function upstream(handler: Parameters<typeof startUpstream>[0]) {
  const u = await startUpstream(handler);
  cleanups.push(() => u.close());
  return u;
}

describe('proxy + mock: full lifecycle', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.close();
  });

  it('streams a completion end-to-end and records an inspectable session', async () => {
    const result = await streamChatCompletion(stack.proxy.url, {
      includeUsage: true,
      headers: { authorization: 'Bearer sk-test-secret-value-123' },
    });
    expect(result.status).toBe(200);
    expect(result.snapshot.outcome).toBe('completed');
    const sessionId = result.headers['x-tokenfault-session'] as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const summary = await waitForSession(stack.proxy.control, sessionId);
    expect(summary).toMatchObject({
      outcome: 'completed',
      completionSignal: 'done-marker',
      status: 200,
      source: 'proxy',
    });
    expect(summary.request).toMatchObject({
      model: 'tokenfault-mock-1',
      stream: true,
      messageCount: 1,
    });
    const detail = await stack.proxy.control.session(sessionId);
    expect(detail.events.length).toBe(result.events.length);
    expect(detail.events.map((e) => e.data)).toEqual(result.events.map((e) => e.data));
    expect(detail.choices[0]?.content).toBe(result.text);
    expect(detail.metrics.usage).not.toBeNull();
    expect(JSON.stringify(detail)).not.toContain('sk-test-secret');
    expect(JSON.stringify(detail)).not.toContain('Hello from the TokenFault test suite');
  });

  it('delegates mock-only scenarios to the upstream mock', async () => {
    const result = await streamChatCompletion(stack.proxy.url, {
      scenario: 'fragmented-tool-calls',
    });
    expect(result.status).toBe(200);
    const call = result.snapshot.choices[0]?.toolCalls[0];
    expect(call?.fragmentCount).toBeGreaterThan(10);
    expect(call?.argumentsValidJson).toBe(true);
    const id = result.headers['x-tokenfault-session'] as string;
    await waitForSession(stack.proxy.control, id);
    const detail = await stack.proxy.control.session(id);
    expect(detail.scenarioId).toBe('fragmented-tool-calls');
    expect(detail.faults).toEqual([]);
    expect(detail.annotations.map((a) => a.faultType)).toEqual(['delegated']);
  });

  it('rejects unknown scenarios and invalid fault headers', async () => {
    const unknown = await streamChatCompletion(stack.proxy.url, { scenario: 'nope' });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(new TextDecoder().decode(unknown.body)).error.code).toBe(
      'tokenfault_invalid_request',
    );
    const mockOnlyFault = await streamChatCompletion(stack.proxy.url, {
      faults: { faults: [{ type: 'fragment-tool-calls', chunkChars: 2 }] },
    });
    expect(mockOnlyFault.status).toBe(400);
  });

  it('B: disconnect through the proxy resets the client after exactly 5 events', async () => {
    const result = await streamChatCompletion(stack.proxy.url, {
      scenario: 'mid-stream-disconnect',
    });
    expect(result.snapshot.metrics.eventCount).toBe(5);
    expect(result.termination.kind).toBe('upstream-reset');
    const id = result.headers['x-tokenfault-session'] as string;
    const detail = await stack.proxy.control.session(
      (await waitForSession(stack.proxy.control, id)).id,
    );
    expect(detail.termination).toMatchObject({ kind: 'fault-disconnect', detail: 'mode=reset' });
    expect(detail.outcome).toBe('incomplete');
    expect(detail.annotations.map((a) => a.faultType)).toEqual(['disconnect']);
    expect(detail.annotations[0]?.afterEvents).toBe(5);
  });

  it('C: injected 429 never reaches the upstream', async () => {
    const before = (await stack.proxy.control.sessions()).length;
    const result = await streamChatCompletion(stack.proxy.url, { scenario: 'rate-limit-429' });
    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('2');
    const id = result.headers['x-tokenfault-session'] as string;
    const s = await waitForSession(stack.proxy.control, id);
    expect(s.outcome).toBe('http-error');
    expect((await stack.proxy.control.sessions()).length).toBe(before + 1);
  });

  it('G: fragmentation through the proxy preserves content and events', async () => {
    const clean = await streamChatCompletion(stack.proxy.url, { prompt: 'frag-proxy' });
    const frag = await streamChatCompletion(stack.proxy.url, {
      prompt: 'frag-proxy',
      scenario: 'fragmented-sse',
    });
    expect(frag.text).toBe(clean.text);
    expect(frag.snapshot.metrics.eventCount).toBe(clean.snapshot.metrics.eventCount);
    expect(frag.snapshot.metrics.chunkCount).toBeGreaterThan(clean.snapshot.metrics.chunkCount * 3);
  });

  it('H: malformed frame injected by the proxy is visible to the client and the session', async () => {
    const result = await streamChatCompletion(stack.proxy.url, { scenario: 'malformed-data' });
    expect(result.events[3]?.interpretation.kind).toBe('invalid-json');
    const id = result.headers['x-tokenfault-session'] as string;
    await waitForSession(stack.proxy.control, id);
    const detail = await stack.proxy.control.session(id);
    expect(detail.diagnostics.map((d) => d.code)).toContain('chat-invalid-json');
  });

  it('applies server-wide faults set through the control API, and "none" overrides them per request', async () => {
    await stack.proxy.control.setFaultProfile({
      faults: [{ type: 'stall', afterEvents: 1, durationMs: 150 }],
    });
    try {
      const stalled = await streamChatCompletion(stack.proxy.url);
      expect(stalled.snapshot.metrics.eventGaps!.maxMs).toBeGreaterThanOrEqual(140);
      const plain = await streamChatCompletion(stack.proxy.url, { scenario: 'none' });
      expect(plain.snapshot.metrics.eventGaps!.maxMs).toBeLessThan(140);
    } finally {
      await stack.proxy.control.clearFaults();
    }
    expect((await stack.proxy.control.info()).activeFaults).toBeNull();
  });

  it('exports payload-free recordings by default and replays them into a new session', async () => {
    const result = await streamChatCompletion(stack.proxy.url);
    const id = result.headers['x-tokenfault-session'] as string;
    await waitForSession(stack.proxy.control, id);
    const recordingText = await stack.proxy.control.recording(id);
    const recording = JSON.parse(recordingText);
    expect(recording.payloads.included).toBe(false);
    expect(recordingText).not.toContain('TokenFault mock response');

    const replay = await stack.proxy.control.replay({
      recording,
      timing: { kind: 'scaled', factor: 4 },
    });
    expect(replay.mode).toBe('events');
    const replayed = await waitForSession(stack.proxy.control, replay.sessionId);
    expect(replayed).toMatchObject({ source: 'replay', outcome: 'completed', replayOf: id });
    expect(replayed.metrics.eventCount).toBe(result.events.length);
  });

  it('replays an in-memory session byte-exactly', async () => {
    const result = await streamChatCompletion(stack.proxy.url, { prompt: 'byte exact' });
    const id = result.headers['x-tokenfault-session'] as string;
    await waitForSession(stack.proxy.control, id);
    const replay = await stack.proxy.control.replay({
      sessionId: id,
      timing: { kind: 'fixed', gapMs: 1 },
    });
    expect(replay.mode).toBe('chunks');
    await waitForSession(stack.proxy.control, replay.sessionId);
    const detail = await stack.proxy.control.session(replay.sessionId);
    expect(detail.choices[0]?.content).toBe(result.text);
    expect(detail.events.map((e) => e.data)).toEqual(result.events.map((e) => e.data));
  });

  it('validates replay and fault inputs', async () => {
    await expect(
      stack.proxy.control.replay({ recording: { schemaVersion: 1 } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(stack.proxy.control.replay({ sessionId: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      stack.proxy.control.setFaultProfile({ faults: [{ type: 'stall' }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(stack.proxy.control.setScenario('fragmented-tool-calls')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('probe sends a request through the proxy and returns its session', async () => {
    const probe = await stack.proxy.control.probe({ scenarioId: 'stream-stall' });
    expect(probe.status).toBe(200);
    expect(probe.sessionId).not.toBeNull();
    const summary = await waitForSession(
      stack.proxy.control,
      probe.sessionId!,
      (s) => s.termination !== null,
      15_000,
    );
    expect(summary.scenarioId).toBe('stream-stall');
    expect(summary.outcome).toBe('completed');
  }, 20_000);

  it('publishes live updates over SSE', async () => {
    const controller = new AbortController();
    const res = await fetch(`${stack.proxy.url}/__tokenfault/api/live`, {
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const seen: string[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const m of buffer.matchAll(/data: (.*)\n\n/g)) seen.push(JSON.parse(m[1]!).type);
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
        if (seen.includes('session-ended')) break;
      }
    })();
    await sleep(50);
    await streamChatCompletion(stack.proxy.url);
    await Promise.race([reading, sleep(3_000)]);
    controller.abort();
    expect(seen[0]).toBe('snapshot');
    expect(seen).toContain('session-started');
    expect(seen).toContain('session-progress');
    expect(seen).toContain('session-ended');
  });
});

describe('proxy transport guarantees', () => {
  it('AC-2.1: streams the first event before the upstream finishes', async () => {
    const up = await upstream(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('first'));
      await sleep(400);
      res.end(sseChunk('second', 'stop') + 'data: [DONE]\n\n');
    });
    const proxy = await proxyTo(up);
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, {
      body: { model: 'x', messages: [] },
    });
    expect(result.events[0]!.atMs).toBeLessThan(250);
    expect(result.events[1]!.atMs).toBeGreaterThanOrEqual(380);
    expect(result.snapshot.outcome).toBe('completed');
  });

  it('AC-2.2: preserves status and safe headers, strips hop-by-hop and TokenFault headers', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(418, {
        'content-type': 'application/json',
        'x-request-id': 'abc',
        'x-custom': 'kept',
        'strict-transport-security': 'max-age=1',
        connection: 'close, x-drop-me',
        'x-drop-me': 'gone',
      });
      res.end('{"error":{"message":"teapot"}}');
    });
    const proxy = await proxyTo(up);
    const result = await streamRequest(`${proxy.url}/v1/thing?key=secret`, {
      body: { a: 1 },
      headers: {
        authorization: 'Bearer sk-upstream-needs-this',
        'x-tokenfault-scenario': 'none',
        'accept-encoding': 'gzip',
        te: 'trailers',
      },
    });
    expect(result.status).toBe(418);
    expect(result.headers['x-request-id']).toBe('abc');
    expect(result.headers['x-custom']).toBe('kept');
    expect(result.headers['strict-transport-security']).toBeUndefined();
    expect(result.headers['x-drop-me']).toBeUndefined();
    const seen = up.requests[0]!;
    expect(seen.url).toBe('/v1/thing?key=secret');
    expect(seen.headers.authorization).toBe('Bearer sk-upstream-needs-this');
    expect(seen.headers['accept-encoding']).toBe('identity');
    expect(seen.headers['x-tokenfault-scenario']).toBeUndefined();
    expect(seen.headers.te).toBeUndefined();
    expect(seen.body).toBe('{"a":1}');
    const sessions = await proxy.control.sessions();
    expect(sessions[0]!.path).toBe('/v1/thing?key=[redacted]');
    expect(sessions[0]!.outcome).toBe('http-error');
  });

  it('AC-2.3: a client disconnect aborts the upstream request', async () => {
    let upstreamClosedAt: number | null = null;
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('a'));
      const timer = setInterval(() => res.write(sseChunk('tick')), 50);
      res.on('close', () => {
        clearInterval(timer);
        upstreamClosedAt = performance.now();
      });
    });
    const proxy = await proxyTo(up);
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 200);
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, {
      body: {},
      signal: controller.signal,
    });
    expect(result.termination.kind).toBe('client-abort');
    await sleep(200);
    expect(upstreamClosedAt).not.toBeNull();
    expect(upstreamClosedAt! - started).toBeLessThan(1_000);
    const [s] = await proxy.control.sessions();
    expect(s!.termination?.kind).toBe('client-abort');
  });

  it('AC-2.4: an upstream reset mid-stream is never turned into a clean EOF', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('partial'));
      setTimeout(() => res.socket?.resetAndDestroy(), 50);
    });
    const proxy = await proxyTo(up);
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, { body: {} });
    expect(result.events).toHaveLength(1);
    expect(result.termination.kind).toBe('upstream-reset');
    expect(result.snapshot.outcome).toBe('incomplete');
    await sleep(50);
    const [s] = await proxy.control.sessions();
    expect(s!.termination?.kind).toBe('upstream-reset');
  });

  it('AC-2.5: unreachable upstream returns 502', async () => {
    const port = await closedPort();
    const proxy = await startProxy({ target: `http://127.0.0.1:${port}` });
    cleanups.push(() => proxy.close());
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, { body: {} });
    expect(result.status).toBe(502);
    expect(JSON.parse(new TextDecoder().decode(result.body)).error.code).toBe(
      'tokenfault_upstream_unreachable',
    );
    const [s] = await proxy.control.sessions();
    expect(s!.termination?.kind).toBe('upstream-unreachable');
  });

  it('AC-2.5: headers timeout returns 504', async () => {
    const up = await upstream(() => undefined); // never responds
    const proxy = await proxyTo(up, { headersTimeoutMs: 200 });
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, { body: {} });
    expect(result.status).toBe(504);
    const [s] = await proxy.control.sessions();
    expect(s!.termination?.kind).toBe('upstream-timeout');
  });

  it('AC-2.5: idle timeout after headers terminates the client connection', async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseChunk('then silence'));
    });
    const proxy = await proxyTo(up, { idleTimeoutMs: 200 });
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, { body: {} });
    expect(result.status).toBe(200);
    expect(result.termination.kind).toBe('upstream-reset');
    expect(result.termination.atMs).toBeGreaterThanOrEqual(190);
    await sleep(50);
    const [s] = await proxy.control.sessions();
    expect(s!.termination).toMatchObject({ kind: 'upstream-timeout' });
  });

  it('applies backpressure: a paused client stops the upstream from being read', async () => {
    let written = 0;
    let upstreamDone = false;
    const up = await upstream(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const block = Buffer.alloc(64 * 1024, 120);
      for (let i = 0; i < 1024 && !res.destroyed; i++) {
        written += block.length;
        if (!res.write(block)) await new Promise((r) => res.once('drain', r));
      }
      upstreamDone = true;
      res.end();
    });
    const proxy = await proxyTo(up, { capturePayloads: false });
    const req = httpRequest(`${proxy.url}/download`, { method: 'GET' });
    const response = await new Promise<IncomingMessage>((resolve) => {
      req.on('response', resolve);
      req.end();
    });
    response.pause();
    await sleep(500);
    // 64 MiB available; with backpressure only socket buffers' worth may be in flight.
    expect(upstreamDone).toBe(false);
    expect(written).toBeLessThan(16 * 1024 * 1024);
    response.destroy();
  });

  it('rejects oversized request bodies with 413', async () => {
    const up = await upstream((_req, res) => void res.end('ok'));
    const proxy = await proxyTo(up, { limits: { maxRequestBodyBytes: 1_024 } });
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, {
      body: 'x'.repeat(5_000),
      headers: { 'content-type': 'text/plain' },
    });
    expect(result.status).toBe(413);
    expect(up.requests).toHaveLength(0);
  });

  it('forwards bodies without a content-type byte-for-byte', async () => {
    const up = await upstream((_req, res) => void res.end('ok'));
    const proxy = await proxyTo(up);
    const result = await streamRequest(`${proxy.url}/raw`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 255]),
    });
    expect(result.status).toBe(200);
    expect(Buffer.from(up.requests[0]!.body, 'utf8').length).toBeGreaterThan(0);
  });
});

describe('proxy security boundaries', () => {
  it('AC-2.6: absolute-form and scheme-relative request targets cannot redirect the upstream', async () => {
    const up = await upstream((_req, res) => void res.end('ok'));
    const proxy = await proxyTo(up);
    const { port } = new URL(proxy.url);
    for (const target of ['http://169.254.169.254/latest/meta-data', '//evil.example/x']) {
      const raw = await new Promise<string>((resolve) => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
          );
        });
        let data = '';
        socket.on('data', (d) => (data += d.toString()));
        socket.on('end', () => resolve(data));
        socket.on('error', () => resolve(data));
      });
      expect(raw.startsWith('HTTP/1.1 400') || raw.startsWith('HTTP/1.1 404')).toBe(true);
    }
    expect(up.requests).toHaveLength(0);
  });

  it('AC-2.6: base path cannot be escaped with dot segments', async () => {
    const up = await upstream((_req, res) => void res.end('ok'));
    const proxy = await startProxy({ target: `${up.url}/openai/v1` });
    cleanups.push(() => proxy.close());
    const ok = await streamRequest(`${proxy.url}/chat/completions`, { body: {} });
    expect(ok.status).toBe(200);
    expect(up.requests[0]!.url).toBe('/openai/v1/chat/completions');
    // Send the literal request target over a raw socket (a URL parser would normalise it client-side).
    const { port } = new URL(proxy.url);
    for (const target of ['/%2e%2e/%2e%2e/admin', '/../../admin', '/..%2f..%2fadmin']) {
      const status = await new Promise<string>((resolve) => {
        const socket = connect(Number(port), '127.0.0.1', () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let data = '';
        socket.on('data', (d) => (data += d.toString()));
        socket.on('end', () => resolve(data.slice(9, 12)));
      });
      expect([target, status]).not.toEqual([target, '200']);
    }
    expect(up.requests.map((r) => r.url).every((u) => u.startsWith('/openai/v1/'))).toBe(true);
  });

  it('rejects non-loopback Host headers on the data path unless allowRemote is set', async () => {
    const up = await upstream((_req, res) => void res.end('ok'));
    const proxy = await proxyTo(up);
    const { port } = new URL(proxy.url);
    const status = await new Promise<string>((resolve) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'GET /v1/models HTTP/1.1\r\nHost: rebind.attacker.example\r\nConnection: close\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (d) => (data += d.toString()));
      socket.on('end', () => resolve(data.slice(9, 12)));
    });
    expect(status).toBe('403');
    expect(up.requests).toHaveLength(0);
    expect((await streamRequest(`${proxy.url}/v1/models`)).status).toBe(200);
  });

  it('AC-2.8: refuses to bind a non-loopback address without allowRemote', () => {
    expect(() => createTokenFaultServer({ target: 'http://127.0.0.1:1', host: '0.0.0.0' })).toThrow(
      ConfigError,
    );
    expect(() =>
      createTokenFaultServer({ target: 'http://127.0.0.1:1', host: '0.0.0.0', allowRemote: true }),
    ).not.toThrow();
  });

  it('rejects unsafe targets at startup', () => {
    for (const target of [
      'ftp://x',
      'http://user:pw@x',
      'http://x/?key=1',
      'not a url',
      'file:///etc/passwd',
    ]) {
      expect(() => createTokenFaultServer({ target })).toThrow(ConfigError);
    }
  });

  describe('AC-2.9: control plane guard', () => {
    let proxy: RunningProxy;
    beforeAll(async () => {
      proxy = await startProxy({ target: 'http://127.0.0.1:9' });
    });
    afterAll(async () => {
      await proxy.close();
    });

    const raw = (method: string, path: string, headers: Record<string, string>, body = '') =>
      new Promise<number>((resolve) => {
        const { port } = new URL(proxy.url);
        const socket = connect(Number(port), '127.0.0.1', () => {
          const lines = [
            `${method} ${path} HTTP/1.1`,
            ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ];
          socket.write(lines.join('\r\n'));
        });
        let data = '';
        socket.on('data', (d) => (data += d.toString()));
        socket.on('end', () => resolve(Number(data.slice(9, 12))));
      });

    it('accepts loopback Host headers', async () => {
      expect(await raw('GET', '/__tokenfault/api/health', { Host: 'localhost' })).toBe(200);
      expect(await raw('GET', '/__tokenfault/api/health', { Host: '127.0.0.1:1234' })).toBe(200);
      expect(await raw('GET', '/__tokenfault/api/health', { Host: '[::1]:80' })).toBe(200);
    });

    it('rejects DNS-rebinding Host headers', async () => {
      expect(await raw('GET', '/__tokenfault/api/sessions', { Host: 'attacker.example' })).toBe(
        403,
      );
      expect(
        await raw('GET', '/__tokenfault/api/sessions', { Host: '127.0.0.1.attacker.example' }),
      ).toBe(403);
      expect(await raw('GET', '/__tokenfault/api/sessions', {})).toBe(400);
    });

    it('rejects cross-site and cross-origin writes, and non-JSON bodies', async () => {
      expect(
        await raw('GET', '/__tokenfault/api/sessions', {
          Host: 'localhost',
          'Sec-Fetch-Site': 'cross-site',
        }),
      ).toBe(403);
      expect(
        await raw('DELETE', '/__tokenfault/api/sessions', {
          Host: 'localhost',
          Origin: 'https://evil.example',
        }),
      ).toBe(403);
      expect(
        await raw('DELETE', '/__tokenfault/api/sessions', {
          Host: 'localhost',
          Origin: 'http://localhost:1',
        }),
      ).toBe(403);
      expect(
        await raw(
          'PUT',
          '/__tokenfault/api/faults',
          { Host: 'localhost', 'Content-Type': 'text/plain' },
          '{"scenarioId":"stream-stall"}',
        ),
      ).toBe(415);
      expect(
        await raw(
          'PUT',
          '/__tokenfault/api/faults',
          { Host: 'localhost', 'Content-Type': 'application/json' },
          '{"scenarioId":"stream-stall"}',
        ),
      ).toBe(200);
      expect(await raw('DELETE', '/__tokenfault/api/faults', { Host: 'localhost' })).toBe(204);
    });

    it('never sends CORS headers and sets security headers', async () => {
      const res = await fetch(`${proxy.url}/__tokenfault/api/info`, {
        headers: { origin: 'https://evil.example' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const info = await new ControlClient(proxy.url).info();
      expect(info.target).toBe('http://127.0.0.1:9');
    });

    it('unknown control paths are never forwarded', async () => {
      expect(await raw('GET', '/__tokenfault/anything', { Host: 'localhost' })).toBe(404);
    });
  });
});
