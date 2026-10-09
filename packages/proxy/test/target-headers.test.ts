import { describe, expect, it } from 'vitest';
import { TargetError, buildUpstreamUrl, parseTarget } from '../src/target.js';
import { forwardRequestHeaders, forwardResponseHeaders } from '../src/headers.js';
import { extractRequestMeta } from '../src/proxy-handler.js';

describe('parseTarget', () => {
  it('accepts http(s) URLs and normalises the base path', () => {
    expect(parseTarget('http://localhost:4010').basePath).toBe('');
    expect(parseTarget('https://api.example.com/v1/').basePath).toBe('/v1');
    expect(parseTarget('https://api.example.com/v1').display).toBe('https://api.example.com/v1');
  });

  it.each([
    'ftp://x',
    'file:///etc/passwd',
    'http://u:p@x',
    'http://x/?a=1',
    'http://x/#f',
    'nope',
  ])('rejects %s', (raw) => {
    expect(() => parseTarget(raw)).toThrow(TargetError);
  });
});

describe('buildUpstreamUrl', () => {
  const root = parseTarget('http://127.0.0.1:4010');
  const based = parseTarget('https://api.example.com/openai/v1');

  it('joins paths and keeps the query', () => {
    expect(buildUpstreamUrl(root, '/v1/chat/completions?x=1')?.href).toBe(
      'http://127.0.0.1:4010/v1/chat/completions?x=1',
    );
    expect(buildUpstreamUrl(based, '/chat/completions')?.href).toBe(
      'https://api.example.com/openai/v1/chat/completions',
    );
  });

  it.each([
    'http://evil.example/',
    '//evil.example/x',
    'evil',
    '/a\\b',
    '/a#frag',
    '/a\u0000b',
    '/a\r\nHost: evil',
  ])('rejects request target %j', (t) => {
    expect(buildUpstreamUrl(root, t)).toBeNull();
  });

  it.each([
    '/../admin',
    '/%2e%2e/admin',
    '/%2E%2E/%2e%2e/admin',
    '/./../x',
    '/..%2f..%2fadmin',
    '/..%5Cadmin',
  ])('prevents base-path escape via %j', (t) => {
    expect(buildUpstreamUrl(based, t)).toBeNull();
  });

  it('never changes the origin', () => {
    for (const t of ['/@evil.example/x', '/:80@evil/x', '/%40evil.example']) {
      const url = buildUpstreamUrl(root, t);
      expect(url === null || url.origin === 'http://127.0.0.1:4010').toBe(true);
    }
  });
});

describe('header forwarding', () => {
  it('strips hop-by-hop, connection-listed and TokenFault headers from requests', () => {
    const out = forwardRequestHeaders(
      {
        host: 'localhost:8787',
        connection: 'keep-alive, x-secret-hop',
        'x-secret-hop': '1',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'proxy-authorization': 'Basic abc',
        'x-tokenfault-scenario': 'none',
        'x-tokenfault-faults': '{}',
        'accept-encoding': 'gzip, br',
        'content-length': '999',
        authorization: 'Bearer sk-x',
        'content-type': 'application/json',
      },
      42,
    );
    expect(out).toEqual({
      authorization: 'Bearer sk-x',
      'content-type': 'application/json',
      'accept-encoding': 'identity',
      'content-length': 42,
    });
  });

  it('sends an explicit zero length for empty bodies of body-carrying methods only', () => {
    expect(forwardRequestHeaders({}, 0, 'POST')['content-length']).toBe(0);
    expect(forwardRequestHeaders({}, 0, 'GET')['content-length']).toBeUndefined();
  });

  it('strips hop-by-hop, HSTS, Alt-Svc and content-length from responses', () => {
    const out = forwardResponseHeaders({
      'content-type': 'text/event-stream',
      'content-length': '10',
      'transfer-encoding': 'chunked',
      'strict-transport-security': 'max-age=1',
      'alt-svc': 'h3=":443"',
      'set-cookie': ['a=1', 'b=2'],
      'x-tokenfault-session': 'spoofed',
    });
    expect(out).toEqual({ 'content-type': 'text/event-stream', 'set-cookie': ['a=1', 'b=2'] });
  });
});

describe('extractRequestMeta', () => {
  it('extracts only non-sensitive facts', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt',
        stream: true,
        messages: [{ role: 'user', content: 'secret prompt' }],
        tools: [{}, {}],
      }),
    );
    const meta = extractRequestMeta(body, 'application/json');
    expect(meta).toEqual({
      model: 'gpt',
      stream: true,
      messageCount: 1,
      toolCount: 2,
      bodyBytes: body.length,
    });
    expect(JSON.stringify(meta)).not.toContain('secret');
  });

  it('handles non-JSON bodies', () => {
    expect(extractRequestMeta(Buffer.from('{oops'), 'application/json')).toEqual({
      model: null,
      stream: null,
      messageCount: null,
      toolCount: null,
      bodyBytes: 5,
    });
  });
});
