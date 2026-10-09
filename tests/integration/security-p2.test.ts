/** Regression tests for the Phase 2 security review (docs/engineering/PHASE2_AUDIT.md). */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startMockLlm } from '@tokenfault/mock-llm';
import { startProxy, streamChatCompletion, streamRequest } from '@tokenfault/testing';
import { sleep, sseChunk, startUpstream } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function raw(url: string, lines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const { port } = new URL(url);
    const socket = connect(Number(port), '127.0.0.1', () => socket.write(lines.join('\r\n')));
    let data = '';
    socket.on('data', (d) => (data += d.toString()));
    socket.on('end', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
}

describe('SEC-1: upstream protocol upgrade', () => {
  it('a 101 reply is answered with 502 and the session terminates instead of hanging', async () => {
    const server = createServer();
    server.on('request', (_req, res) => {
      // Raw 101 without an upgrade request from the proxy.
      res.socket?.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n',
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const proxy = await startProxy({
      target: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      headersTimeoutMs: 5_000,
    });
    cleanups.push(() => proxy.close());
    const started = performance.now();
    const result = await streamRequest(`${proxy.url}/v1/chat/completions`, {
      body: {},
      timeoutMs: 4_000,
    });
    expect(result.status).toBe(502);
    expect(performance.now() - started).toBeLessThan(2_000);
    const [session] = await proxy.control.sessions();
    expect(session?.termination?.kind).toBe('upstream-unreachable');
  });
});

describe('SEC-2: forwarded content is isolated from the control origin', () => {
  it('adds sandbox CSP and nosniff to forwarded and generated responses, keeping upstream CSP', async () => {
    const up = await startUpstream((req, res) => {
      if (req.url?.includes('csp')) res.setHeader('content-security-policy', "default-src 'self'");
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(`<script>fetch('/__tokenfault/api/faults',{method:'PUT'})</script>`);
    });
    cleanups.push(() => up.close());
    const proxy = await startProxy({ target: up.url });
    cleanups.push(() => proxy.close());
    const html = await streamRequest(`${proxy.url}/v1/x`, { method: 'GET' });
    expect(html.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    const withCsp = await streamRequest(`${proxy.url}/v1/csp`, { method: 'GET' });
    expect(withCsp.headers['content-security-policy']).toBe(
      "default-src 'self', sandbox; default-src 'none'",
    );
    const injected = await streamChatCompletion(proxy.url, { scenario: 'rate-limit-429' });
    expect(injected.headers['content-security-policy']).toContain('sandbox');
  });

  it('refuses cross-site navigations on the data path but allows cross-site fetches', async () => {
    const up = await startUpstream((_req, res) => void res.end('ok'));
    cleanups.push(() => up.close());
    const proxy = await startProxy({ target: up.url });
    cleanups.push(() => proxy.close());
    const nav = await raw(proxy.url, [
      'GET /v1/models HTTP/1.1',
      'Host: 127.0.0.1',
      'Sec-Fetch-Site: cross-site',
      'Sec-Fetch-Mode: navigate',
      'Connection: close',
      '',
      '',
    ]);
    expect(nav.slice(9, 12)).toBe('403');
    const fetchCors = await raw(proxy.url, [
      'GET /v1/models HTTP/1.1',
      'Host: 127.0.0.1',
      'Sec-Fetch-Site: cross-site',
      'Sec-Fetch-Mode: cors',
      'Connection: close',
      '',
      '',
    ]);
    expect(fetchCors.slice(9, 12)).toBe('200');
    expect(up.requests).toHaveLength(1);
  });
});

describe('SEC-3/4/7: no secrets or raw paths in logs, sessions or framework errors', () => {
  it('redacts query values and bare parameters everywhere and never echoes malformed paths', async () => {
    const lines: string[] = [];
    const up = await startUpstream((_req, res) => void res.end('ok'));
    cleanups.push(() => up.close());
    const proxy = await startProxy({
      target: up.url,
      logger: true,
      logDestination: { write: (l: string) => lines.push(l) },
    });
    cleanups.push(() => proxy.close());
    await streamRequest(`${proxy.url}/v1/x?key=QUERYSECRET1&BARESECRET2`, { method: 'GET' });
    const trace = await raw(proxy.url, [
      'TRACE /v1/x?key=QUERYSECRET3 HTTP/1.1',
      'Host: 127.0.0.1',
      'Connection: close',
      '',
      '',
    ]);
    expect(trace.slice(9, 12)).toBe('405');
    const bad = await raw(proxy.url, [
      'GET /__tokenfault/api/sessions/%ZZ?k=PATHSECRET4 HTTP/1.1',
      'Host: evil.example',
      'Connection: close',
      '',
      '',
    ]);
    expect(bad.slice(9, 12)).toBe('400');
    expect(bad).not.toContain('PATHSECRET4');
    await sleep(50);
    const sessions = JSON.stringify(await proxy.control.sessions());
    const everything = lines.join('\n') + sessions + trace + bad;
    for (const secret of ['QUERYSECRET1', 'BARESECRET2', 'QUERYSECRET3', 'PATHSECRET4'])
      expect(everything).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('SEC-5: mock server output is bounded', () => {
  it('clips huge schema values echoed into tool arguments', async () => {
    const mock = await startMockLlm({ eventIntervalMs: 0 });
    cleanups.push(() => mock.close());
    const huge = 'A'.repeat(2_000_000);
    const result = await streamChatCompletion(mock.url, {
      tools: [
        {
          type: 'function',
          function: {
            name: 'f',
            parameters: {
              type: 'object',
              properties: { a: { type: 'string', enum: [huge] }, b: { enum: [{ nested: huge }] } },
            },
          },
        },
      ],
    });
    const call = result.snapshot.choices[0]?.toolCalls[0];
    expect(call?.argumentsValidJson).toBe(true);
    expect(call?.argumentsLength).toBeLessThanOrEqual(4_096);
    expect(result.snapshot.metrics.byteCount).toBeLessThan(100_000);
  });
});

describe('SEC-6: Studio paths are decoded exactly once', () => {
  it('looks up %2541 literally as "%41"', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tf-studio-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    await mkdir(path.join(dir, 'assets'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(dir, '%41.txt'), 'literal');
    await writeFile(path.join(dir, 'A.txt'), 'decoded-twice');
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', studioDir: dir });
    cleanups.push(() => proxy.close());
    const res = await fetch(`${proxy.url}/__tokenfault/studio/%2541.txt`);
    expect(await res.text()).toBe('literal');
  });
});

describe('SEC-2 support: SSE through the isolation headers still works for clients', () => {
  it('streams normally', async () => {
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseChunk('ok', 'stop') + 'data: [DONE]\n\n');
    });
    cleanups.push(() => up.close());
    const proxy = await startProxy({ target: up.url });
    cleanups.push(() => proxy.close());
    const r = await streamRequest(`${proxy.url}/v1/chat/completions`, { body: {} });
    expect(r.snapshot.outcome).toBe('completed');
  });
});
