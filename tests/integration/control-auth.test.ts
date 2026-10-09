/** Control-plane authentication (SEC-8, DECISIONS D-021). */
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenFaultServer } from '@tokenfault/proxy';
import { ControlClient, startProxy, streamChatCompletion } from '@tokenfault/testing';
import { ControlAuth, readCookie, safeEqual } from '../../packages/proxy/src/control-auth.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const TOKEN = 'test-control-token-0123456789abcdefghij';

describe('control API authentication (default on)', () => {
  it('generates a random token per run when none is given', () => {
    const a = createTokenFaultServer({ target: 'http://127.0.0.1:9' });
    const b = createTokenFaultServer({ target: 'http://127.0.0.1:9' });
    expect(a.controlToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.controlToken).not.toBe(b.controlToken);
    expect(
      createTokenFaultServer({ target: 'http://127.0.0.1:9', controlToken: null }).controlToken,
    ).toBeNull();
    expect(() =>
      createTokenFaultServer({ target: 'http://127.0.0.1:9', controlToken: 'short' }),
    ).toThrow();
  });

  it('rejects every data-bearing control route without credentials and accepts the bearer token', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const base = `${proxy.url}/__tokenfault/api`;
    for (const [method, path] of [
      ['GET', '/info'],
      ['GET', '/sessions'],
      ['GET', '/sessions/x'],
      ['GET', '/sessions/x/recording'],
      ['GET', '/live'],
      ['GET', '/faults'],
      ['GET', '/scenarios'],
      ['DELETE', '/sessions'],
      ['DELETE', '/faults'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect([path, res.status]).toEqual([path, 401]);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    }
    for (const path of ['/faults', '/replays', '/probe']) {
      const res = await fetch(`${base}${path}`, {
        method: path === '/faults' ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect([path, res.status]).toEqual([path, 401]);
    }
    expect(
      (
        await fetch(`${base}/info`, {
          headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(`${base}/info`, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(await (await fetch(`${base}/auth/status`)).json()).toEqual({
      required: true,
      authenticated: false,
    });
    expect((await proxy.control.info()).controlAuth).toBe(true);
  });

  it('Studio sign-in issues an HttpOnly SameSite=Strict cookie scoped to the control prefix, and logout revokes it', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const base = `${proxy.url}/__tokenfault/api`;
    const bad = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const ok = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(
      /^tf_session=[A-Za-z0-9_-]{43}; Path=\/__tokenfault; HttpOnly; SameSite=Strict; Max-Age=43200$/,
    );
    expect(cookie).not.toContain(TOKEN);
    const session = cookie.split(';')[0]!;
    expect((await fetch(`${base}/sessions`, { headers: { cookie: session } })).status).toBe(200);
    expect(
      await (await fetch(`${base}/auth/status`, { headers: { cookie: session } })).json(),
    ).toEqual({ required: true, authenticated: true });
    const out = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: session },
    });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${base}/sessions`, { headers: { cookie: session } })).status).toBe(401);
  });

  it('login is still subject to the Origin and JSON guards', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const res = await fetch(`${proxy.url}/__tokenfault/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(403);
  });

  it('rate-limits failed sign-ins', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const attempt = (token: string) =>
      fetch(`${proxy.url}/__tokenfault/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt(`wrong-${i}`)).status).toBe(401);
    // Further wrong guesses are throttled...
    expect((await attempt('wrong-again')).status).toBe(429);
    // ...but failing on purpose cannot lock the real user out (SEC-R2).
    expect((await attempt(TOKEN)).status).toBe(200);
  });

  it('can be disabled explicitly, and the data path never needs the token', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: null });
    cleanups.push(() => proxy.close());
    expect((await fetch(`${proxy.url}/__tokenfault/api/sessions`)).status).toBe(200);
    expect((await new ControlClient(proxy.url).info()).controlAuth).toBe(false);
    const authed = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => authed.close());
    const r = await streamChatCompletion(authed.url, { scenario: 'rate-limit-429' });
    expect(r.status).toBe(429);
  });

  it('never logs or returns the token', async () => {
    const lines: string[] = [];
    const proxy = await startProxy({
      target: 'http://127.0.0.1:9',
      controlToken: TOKEN,
      logger: true,
      logDestination: { write: (l: string) => lines.push(l) },
    });
    cleanups.push(() => proxy.close());
    await fetch(`${proxy.url}/__tokenfault/api/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const info = await proxy.control.info();
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(info)).not.toContain(TOKEN);
  });
});

describe('ControlAuth unit behaviour', () => {
  it('compares in constant time over digests and parses cookies strictly', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(readCookie('x=1; tf_session=abc_DEF-1', 'tf_session')).toBe('abc_DEF-1');
    expect(readCookie('tf_session=bad value', 'tf_session')).toBeNull();
    expect(readCookie(undefined, 'tf_session')).toBeNull();
  });

  it('expires sessions', () => {
    let now = 0;
    const auth = new ControlAuth(TOKEN, () => now);
    const r = auth.login(TOKEN);
    if (!r.ok) throw new Error('login failed');
    expect(auth.isAuthenticated({ cookie: `tf_session=${r.sessionId}` })).toBe(true);
    now += 12 * 60 * 60 * 1000 + 1;
    expect(auth.isAuthenticated({ cookie: `tf_session=${r.sessionId}` })).toBe(false);
  });
});

describe('phase 3 security regressions', () => {
  async function signIn(url: string): Promise<string> {
    const res = await fetch(`${url}/__tokenfault/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    return cookie.split(';')[0]!;
  }

  it('SEC-R1: the live feed stops sending once the Studio session is logged out', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const cookie = await signIn(proxy.url);
    const controller = new AbortController();
    const live = await fetch(`${proxy.url}/__tokenfault/api/live`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(live.status).toBe(200);
    expect(live.headers.get('x-frame-options')).toBe('DENY');
    const reader = live.body!.getReader();
    await reader.read(); // snapshot
    await fetch(`${proxy.url}/__tokenfault/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
    });
    // Any store change after logout must not reach the old subscriber.
    await streamChatCompletion(proxy.url, { scenario: 'rate-limit-429' });
    let received = '';
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
    } catch {
      // aborted by the timeout: the stream stayed open, checked below
    }
    clearTimeout(timeout);
    expect(received).toBe('');
    expect(controller.signal.aborted).toBe(false); // the server closed the stream itself
  });

  it('SEC-R3: a planted tf_session cookie cannot shadow the real session', async () => {
    const proxy = await startProxy({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const cookie = await signIn(proxy.url);
    const res = await fetch(`${proxy.url}/__tokenfault/api/sessions`, {
      headers: { cookie: `tf_session=planted_junk_value; ${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  it('SEC-R3: upstream Set-Cookie headers aimed at the control session are dropped', async () => {
    const { startUpstream } = await import('./helpers.js');
    const up = await startUpstream((_req, res) => {
      res.setHeader('set-cookie', [
        'tf_session=evil; Path=/__tokenfault/api',
        'other=1; Path=/__tokenfault/api',
        'app=kept; Path=/',
      ]);
      res.end('ok');
    });
    cleanups.push(() => up.close());
    const proxy = await startProxy({ target: up.url, controlToken: TOKEN });
    cleanups.push(() => proxy.close());
    const res = await fetch(`${proxy.url}/v1/x`);
    expect(res.headers.getSetCookie()).toEqual(['app=kept; Path=/']);
  });

  it('SEC-R5: the proxy bounds the time to receive a request but not to stream a response', () => {
    const server = createTokenFaultServer({ target: 'http://127.0.0.1:9', controlToken: TOKEN });
    expect(server.app.server.requestTimeout).toBe(120_000);
  });
});

describe('ControlAuth: multiple session cookies', () => {
  it('accepts a valid session among several tf_session values (SEC-R3)', () => {
    const auth = new ControlAuth(TOKEN);
    const result = auth.login(TOKEN);
    if (!result.ok) throw new Error('login failed');
    expect(
      auth.isAuthenticated({ cookie: `tf_session=junk; tf_session=${result.sessionId}` }),
    ).toBe(true);
    auth.logout({ cookie: `tf_session=junk; tf_session=${result.sessionId}` });
    expect(auth.isAuthenticated({ cookie: `tf_session=${result.sessionId}` })).toBe(false);
  });
});
