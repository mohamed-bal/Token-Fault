import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockLlm } from '@tokenfault/mock-llm';
import type { RunningMockLlm } from '@tokenfault/mock-llm';
import { streamChatCompletion, streamRequest } from '@tokenfault/testing';

let mock: RunningMockLlm;

beforeAll(async () => {
  mock = await startMockLlm({ eventIntervalMs: 2 });
});
afterAll(async () => {
  await mock.close();
});

describe('mock LLM: protocol', () => {
  it('streams a complete, valid chat completion', async () => {
    const result = await streamChatCompletion(mock.url, { includeUsage: true });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(result.snapshot.outcome).toBe('completed');
    expect(result.snapshot.completionSignal).toBe('done-marker');
    expect(result.termination.kind).toBe('eof');
    expect(result.text).toMatch(/^TokenFault mock response\./);
    expect(result.text).toContain('世界');
    expect(result.snapshot.metrics.usage).not.toBeNull();
    expect(result.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('is deterministic for identical requests and differs for different prompts', async () => {
    const a = await streamChatCompletion(mock.url, { prompt: 'same' });
    const b = await streamChatCompletion(mock.url, { prompt: 'same' });
    const c = await streamChatCompletion(mock.url, { prompt: 'different prompt' });
    expect(a.text).toBe(b.text);
    expect(a.events.map((e) => e.data?.replace(/"created":\d+/, ''))).toEqual(
      b.events.map((e) => e.data?.replace(/"created":\d+/, '')),
    );
    expect(c.text).not.toBe(a.text);
  });

  it('honours max_tokens with finish_reason length', async () => {
    const result = await streamChatCompletion(mock.url, { extraBody: { max_tokens: 3 } });
    expect(result.snapshot.metrics.contentDeltaCount).toBe(3);
    expect(result.snapshot.choices[0]?.finishReason).toBe('length');
  });

  it('answers non-streaming requests', async () => {
    const result = await streamChatCompletion(mock.url, { stream: false });
    expect(result.status).toBe(200);
    expect(result.snapshot.outcome).toBe('non-stream');
    const body = JSON.parse(new TextDecoder().decode(result.body));
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toMatch(/^TokenFault mock response\./);
  });

  it('streams tool calls with valid assembled arguments', async () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' }, n: { type: 'integer' } },
          },
        },
      },
    ];
    const result = await streamChatCompletion(mock.url, { tools });
    const call = result.snapshot.choices[0]?.toolCalls[0];
    expect(call).toMatchObject({ name: 'lookup', argumentsValidJson: true });
    expect(JSON.parse(call!.arguments!)).toEqual({ q: 'example q', n: 3 });
    expect(result.snapshot.choices[0]?.finishReason).toBe('tool_calls');
  });

  it('rejects invalid requests with OpenAI-style errors', async () => {
    const result = await streamRequest(`${mock.url}/v1/chat/completions`, {
      body: { model: 'x', messages: [] },
    });
    expect(result.status).toBe(400);
    const body = JSON.parse(new TextDecoder().decode(result.body));
    expect(body.error.type).toBe('invalid_request_error');
    const n = await streamRequest(`${mock.url}/v1/chat/completions`, {
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }], n: 2 },
    });
    expect(n.status).toBe(400);
  });

  it('rejects malformed fault headers', async () => {
    const bad = await streamChatCompletion(mock.url, { scenario: 'does-not-exist' });
    expect(bad.status).toBe(400);
    const badJson = await streamChatCompletion(mock.url, {
      headers: { 'x-tokenfault-faults': '{nope' },
    });
    expect(badJson.status).toBe(400);
  });

  it('lists models and reports health', async () => {
    const models = await streamRequest(`${mock.url}/v1/models`);
    expect(JSON.parse(new TextDecoder().decode(models.body)).data[0].id).toBe('tokenfault-mock-1');
    expect((await streamRequest(`${mock.url}/healthz`)).status).toBe(200);
  });
});

describe('mock LLM: fault scenarios (observed from the client)', () => {
  it('A: slow first response delays first byte and first content', async () => {
    const result = await streamChatCompletion(mock.url, {
      faults: {
        faults: [
          { type: 'delay-first-byte', delayMs: 300 },
          { type: 'delay-first-content', delayMs: 200 },
        ],
      },
    });
    const m = result.snapshot.metrics;
    expect(m.headersMs!).toBeGreaterThanOrEqual(290);
    expect(m.firstContentMs! - m.firstEventMs!).toBeGreaterThanOrEqual(190);
    expect(result.snapshot.outcome).toBe('completed');
  });

  it('B: mid-stream disconnect (reset) yields an incomplete stream with exactly N events', async () => {
    const result = await streamChatCompletion(mock.url, { scenario: 'mid-stream-disconnect' });
    expect(result.status).toBe(200);
    expect(result.snapshot.metrics.eventCount).toBe(5);
    expect(result.termination.kind).toBe('upstream-reset');
    expect(result.snapshot.outcome).toBe('incomplete');
  });

  it('B: disconnect mode "end" produces a clean EOF but an incomplete stream', async () => {
    const result = await streamChatCompletion(mock.url, {
      faults: { faults: [{ type: 'disconnect', afterEvents: 2, mode: 'end' }] },
    });
    expect(result.termination.kind).toBe('eof');
    expect(result.snapshot.metrics.eventCount).toBe(2);
    expect(result.snapshot.outcome).toBe('incomplete');
  });

  it('B: time-based disconnect', async () => {
    const result = await streamChatCompletion(mock.url, {
      faults: { faults: [{ type: 'disconnect', afterMs: 15, mode: 'destroy' }] },
    });
    expect(result.termination.kind).toBe('upstream-reset');
    expect(result.snapshot.outcome).toBe('incomplete');
  });

  it('C: 429 with Retry-After before streaming', async () => {
    const result = await streamChatCompletion(mock.url, { scenario: 'rate-limit-429' });
    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('2');
    expect(result.snapshot.outcome).toBe('http-error');
    expect(JSON.parse(new TextDecoder().decode(result.body)).error.code).toBe(
      'rate_limit_exceeded',
    );
  });

  it('D: 503 before streaming', async () => {
    const result = await streamChatCompletion(mock.url, { scenario: 'server-unavailable-503' });
    expect(result.status).toBe(503);
    expect(result.events).toHaveLength(0);
  });

  it('E: stall produces one large gap and then completes', async () => {
    const result = await streamChatCompletion(mock.url, {
      faults: { faults: [{ type: 'stall', afterEvents: 2, durationMs: 300 }] },
    });
    expect(result.snapshot.metrics.eventGaps!.maxMs).toBeGreaterThanOrEqual(290);
    expect(result.events[2]!.atMs - result.events[1]!.atMs).toBeGreaterThanOrEqual(290);
    expect(result.snapshot.outcome).toBe('completed');
  });

  it('F: jitter stays within bounds', async () => {
    const result = await streamChatCompletion(mock.url, {
      faults: { seed: 42, faults: [{ type: 'jitter', minGapMs: 20, maxGapMs: 40 }] },
    });
    expect(result.snapshot.metrics.eventGaps!.minMs).toBeGreaterThanOrEqual(15);
    expect(result.snapshot.outcome).toBe('completed');
  });

  it('G: fragmented SSE yields the same content in many more chunks', async () => {
    const clean = await streamChatCompletion(mock.url, { prompt: 'frag' });
    const fragmented = await streamChatCompletion(mock.url, {
      prompt: 'frag',
      scenario: 'fragmented-sse',
    });
    expect(fragmented.text).toBe(clean.text);
    expect(fragmented.snapshot.metrics.eventCount).toBe(clean.snapshot.metrics.eventCount);
    expect(fragmented.snapshot.metrics.chunkCount).toBeGreaterThan(
      clean.snapshot.metrics.chunkCount * 3,
    );
    expect(fragmented.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('H: malformed data is reported and the stream continues', async () => {
    const result = await streamChatCompletion(mock.url, { scenario: 'malformed-data' });
    expect(result.events[3]!.interpretation.kind).toBe('invalid-json');
    expect(result.diagnostics.map((d) => d.code)).toContain('chat-invalid-json');
    expect(result.snapshot.completionSignal).toBe('done-marker');
  });

  it('I: fragmented tool calls assemble into valid JSON', async () => {
    const result = await streamChatCompletion(mock.url, { scenario: 'fragmented-tool-calls' });
    const call = result.snapshot.choices[0]!.toolCalls[0]!;
    expect(call.name).toBe('get_weather');
    expect(call.fragmentCount).toBeGreaterThan(10);
    expect(call.argumentsValidJson).toBe(true);
    expect(
      result.events.filter((e) => e.interpretation.toolCalls.some((t) => t.id !== null)),
    ).toHaveLength(1);
  });

  it('a client abort stops the server stream', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const result = await streamChatCompletion(mock.url, {
      signal: controller.signal,
      faults: { faults: [{ type: 'stall', afterEvents: 1, durationMs: 5_000 }] },
    });
    expect(result.termination.kind).toBe('client-abort');
    expect(result.termination.atMs).toBeLessThan(1_000);
  });
});
