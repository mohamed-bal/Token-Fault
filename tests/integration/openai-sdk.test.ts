/**
 * Contract tests with the official `openai` Node SDK (5.x): the mock and the
 * proxy must be consumable by a real OpenAI client, and injected faults must
 * surface as the errors that client raises.
 */
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, waitForSession } from '@tokenfault/testing';
import type { Stack } from '@tokenfault/testing';

let stack: Stack;
let client: OpenAI;

beforeAll(async () => {
  stack = await startStack();
  client = new OpenAI({
    apiKey: 'sk-test-not-a-real-key-000000',
    baseURL: `${stack.proxy.url}/v1`,
    maxRetries: 0,
    timeout: 10_000,
  });
});
afterAll(async () => {
  await stack.close();
});

describe('openai SDK through TokenFault proxy → mock', () => {
  it('streams chat completion chunks', async () => {
    const stream = await client.chat.completions.create({
      model: 'tokenfault-mock-1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'contract test' }],
    });
    let text = '';
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
      finish = chunk.choices[0]?.finish_reason ?? finish;
      usage = chunk.usage ?? usage;
    }
    expect(text).toMatch(/^TokenFault mock response\./);
    expect(finish).toBe('stop');
    expect(usage?.total_tokens).toBeGreaterThan(0);
  });

  it('assembles fragmented tool calls with the SDK stream helper', async () => {
    const runner = client.chat.completions.stream(
      {
        model: 'tokenfault-mock-1',
        messages: [{ role: 'user', content: 'call a tool' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: { location: { type: 'string' } } },
            },
          },
        ],
      },
      { headers: { 'x-tokenfault-scenario': 'fragmented-tool-calls' } },
    );
    const completion = await runner.finalChatCompletion();
    const call = completion.choices[0]?.message.tool_calls?.[0];
    expect(call?.type).toBe('function');
    expect(call && 'function' in call ? JSON.parse(call.function.arguments) : null).toEqual({
      location: 'Paris, France',
    });
  });

  it('returns non-streaming completions', async () => {
    const completion = await client.chat.completions.create({
      model: 'tokenfault-mock-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(completion.choices[0]?.message.content).toMatch(/^TokenFault mock response\./);
  });

  it('surfaces an injected 429 as RateLimitError', async () => {
    const error = await client.chat.completions
      .create(
        { model: 'tokenfault-mock-1', stream: true, messages: [{ role: 'user', content: 'x' }] },
        { headers: { 'x-tokenfault-scenario': 'rate-limit-429' } },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
    expect(error instanceof OpenAI.APIError ? error.status : null).toBe(429);
  });

  it('surfaces a mid-stream disconnect as an error while iterating, never as a clean end', async () => {
    const stream = await client.chat.completions.create(
      { model: 'tokenfault-mock-1', stream: true, messages: [{ role: 'user', content: 'x' }] },
      { headers: { 'x-tokenfault-scenario': 'mid-stream-disconnect' } },
    );
    let chunks = 0;
    const consume = async (): Promise<void> => {
      for await (const _chunk of stream) chunks += 1;
    };
    await expect(consume()).rejects.toThrow();
    expect(chunks).toBe(5);
  });

  it('never stores the API key in the session', async () => {
    const stream = await client.chat.completions.create({
      model: 'tokenfault-mock-1',
      stream: true,
      messages: [{ role: 'user', content: 'secret prompt text' }],
    });
    for await (const _chunk of stream) {
      // drain
    }
    const [latest] = await stack.proxy.control.sessions();
    await waitForSession(stack.proxy.control, latest!.id);
    const detail = JSON.stringify(await stack.proxy.control.session(latest!.id));
    expect(detail).not.toContain('sk-test-not-a-real-key');
    expect(detail).not.toContain('secret prompt text');
  });
});
