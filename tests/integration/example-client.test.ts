import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack } from '@tokenfault/testing';
import type { Stack } from '@tokenfault/testing';
import { StreamError, resilientChat } from '../../examples/basic-client/src/resilient-client.ts';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack.close();
});

const run = (scenario: string, extra: Partial<Parameters<typeof resilientChat>[0]> = {}) =>
  resilientChat({
    baseUrl: stack.proxy.url,
    prompt: 'example',
    headers: { 'x-tokenfault-scenario': scenario },
    baseBackoffMs: 10,
    ...extra,
  });

describe('example resilient client against TokenFault scenarios', () => {
  it('completes a normal stream', async () => {
    const result = await run('none');
    expect(result.text).toMatch(/^TokenFault mock response\./);
    expect(result.finishReason).toBe('stop');
    expect(result.attempts).toBe(1);
  });

  it('is unaffected by fragmentation', async () => {
    expect((await run('fragmented-sse')).text).toBe((await run('none')).text);
  });

  it('reports a mid-stream disconnect as incomplete instead of returning partial text', async () => {
    await expect(run('mid-stream-disconnect')).rejects.toMatchObject({ kind: 'incomplete' });
  });

  it('times out a stalled stream with the idle timeout', async () => {
    await expect(run('stream-stall', { idleTimeoutMs: 500 })).rejects.toMatchObject({
      kind: 'idle-timeout',
    });
  });

  it('retries 429 honouring Retry-After and gives up after maxAttempts', async () => {
    const started = Date.now();
    const error = await run('rate-limit-429', { maxAttempts: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamError);
    expect(error).toMatchObject({ kind: 'http', status: 429, retryAfterMs: 2000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  it('hits the first-byte timeout on a slow first response', async () => {
    await expect(
      run('slow-first-response', { firstByteTimeoutMs: 300, maxAttempts: 1 }),
    ).rejects.toMatchObject({ kind: 'first-byte-timeout' });
  });
});
