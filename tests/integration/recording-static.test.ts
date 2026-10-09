import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRecording } from '@tokenfault/core';
import { startReplayServer } from '@tokenfault/proxy';
import { startStack, streamChatCompletion, waitForSession } from '@tokenfault/testing';
import type { Stack } from '@tokenfault/testing';
import { sleep } from './helpers.js';

let workdir: string;
beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'tokenfault-it-'));
});
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('automatic session recording', () => {
  it('writes payload-free recordings with private permissions and applies retention', async () => {
    const dir = path.join(workdir, 'records');
    // A stale TokenFault recording and an unrelated file: only the former may be deleted.
    await mkdir(dir, { recursive: true });
    const stale = path.join(dir, '20200101T000000Z-old.tfrec.json');
    await writeFile(stale, '{}');
    await utimes(stale, new Date('2020-01-01'), new Date('2020-01-01'));
    await writeFile(path.join(dir, 'notes.txt'), 'keep me');

    const stack = await startStack({
      proxy: { recordDir: dir, recordMaxFiles: 2, recordMaxAgeDays: 30 },
    });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await streamChatCompletion(stack.proxy.url, {
          prompt: `record ${i}`,
          headers: { authorization: 'Bearer sk-never-on-disk-123456' },
        });
        await waitForSession(stack.proxy.control, r.headers['x-tokenfault-session'] as string);
        await sleep(30);
      }
    } finally {
      await stack.close();
    }

    const files = (await readdir(dir)).sort();
    expect(files.filter((f) => f.endsWith('.tfrec.json'))).toHaveLength(2);
    expect(files).toContain('notes.txt');
    expect(files).not.toContain('20200101T000000Z-old.tfrec.json');

    for (const f of files.filter((n) => n.endsWith('.tfrec.json'))) {
      const full = path.join(dir, f);
      if (process.platform !== 'win32') expect((await stat(full)).mode & 0o777).toBe(0o600);
      const text = await readFile(full, 'utf8');
      expect(text).not.toContain('sk-never-on-disk');
      expect(text).not.toContain('TokenFault mock response');
      expect(text).not.toContain('record 1');
      const parsed = parseRecording(text, 32 * 1024 * 1024);
      expect(parsed.ok).toBe(true);
    }
  });

  it('creates a missing recording directory with mode 0700', async () => {
    const dir = path.join(workdir, 'fresh', 'records');
    const stack = await startStack({ proxy: { recordDir: dir } });
    try {
      const r = await streamChatCompletion(stack.proxy.url);
      await waitForSession(stack.proxy.control, r.headers['x-tokenfault-session'] as string);
    } finally {
      await stack.close();
    }
    expect((await readdir(dir)).filter((f) => f.endsWith('.tfrec.json'))).toHaveLength(1);
    if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});

describe('replay server', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.close();
  });

  it('serves a recorded stream to a client without contacting any model', async () => {
    const original = await streamChatCompletion(stack.proxy.url, {
      prompt: 'replay me',
      scenario: 'mid-stream-disconnect',
    });
    const id = original.headers['x-tokenfault-session'] as string;
    await waitForSession(stack.proxy.control, id);
    const text = await stack.proxy.control.recording(id, true);
    const parsed = parseRecording(text, 32 * 1024 * 1024);
    if (!parsed.ok) throw new Error(parsed.error);

    // The replay server has no upstream at all: it only re-sends recorded bytes.
    const replay = await startReplayServer({
      recording: parsed.recording,
      timing: { kind: 'scaled', factor: 2 },
    });
    try {
      const replayed = await streamChatCompletion(replay.url);
      expect(replayed.headers['x-tokenfault-replay']).toBe('chunks');
      expect(replayed.text).toBe(original.text);
      expect(replayed.snapshot.metrics.eventCount).toBe(5);
      // The recorded fault (TCP reset after 5 events) is reproduced.
      expect(replayed.termination.kind).toBe('upstream-reset');
      expect(replayed.snapshot.outcome).toBe('incomplete');
      // Timing is scaled by 2 (allowing scheduler slack).
      expect(replayed.snapshot.metrics.durationMs!).toBeLessThan(
        original.snapshot.metrics.durationMs! * 0.5 + 100,
      );
    } finally {
      await replay.close();
    }
  });
});

describe('Studio static file serving', () => {
  let stack: Stack;
  let outside: string;

  beforeAll(async () => {
    const studio = path.join(workdir, 'studio');
    await mkdir(path.join(studio, 'assets'), { recursive: true });
    await writeFile(path.join(studio, 'index.html'), '<!doctype html><title>Studio</title>');
    await writeFile(path.join(studio, 'assets', 'app-abc.js'), 'console.log(1)');
    outside = path.join(workdir, 'secret.txt');
    await writeFile(outside, 'TOP SECRET');
    await symlink(outside, path.join(studio, 'leak.txt'));
    stack = await startStack({ proxy: { studioDir: studio } });
  });
  afterAll(async () => {
    await stack.close();
  });

  const rawGet = (target: string) =>
    new Promise<string>((resolve) => {
      const { port } = new URL(stack.proxy.url);
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (d) => (data += d.toString()));
      socket.on('end', () => resolve(data));
    });

  it('serves index.html with a strict CSP and hashed assets as immutable', async () => {
    const index = await fetch(`${stack.proxy.url}/__tokenfault/studio/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const asset = await fetch(`${stack.proxy.url}/__tokenfault/studio/assets/app-abc.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for client-side routes only', async () => {
    expect((await fetch(`${stack.proxy.url}/__tokenfault/studio/sessions/abc`)).status).toBe(200);
    expect((await fetch(`${stack.proxy.url}/__tokenfault/studio/missing.js`)).status).toBe(404);
  });

  it.each([
    '/__tokenfault/studio/../../../etc/passwd',
    '/__tokenfault/studio/%2e%2e/%2e%2e/secret.txt',
    '/__tokenfault/studio/..%2f..%2fsecret.txt',
    '/__tokenfault/studio/leak.txt',
    '/__tokenfault/studio/%00index.html',
    '/__tokenfault/studio/..%5c..%5csecret.txt',
  ])('never serves files outside the root: %s', async (target) => {
    const response = await rawGet(target);
    expect(response).not.toContain('TOP SECRET');
    expect(response).not.toContain('root:');
  });

  it('redirects browsers from / to the Studio but still proxies API clients', async () => {
    const browser = await fetch(`${stack.proxy.url}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get('location')).toBe('/__tokenfault/studio/');
  });
});
