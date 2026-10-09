import { describe, expect, it } from 'vitest';
import { ChatStreamAccumulator, interpretChatEventData } from '../src/openai/chat-stream.js';

const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices,
    ...extra,
  });

describe('interpretChatEventData', () => {
  it('recognises [DONE] only as exact data', () => {
    expect(interpretChatEventData('[DONE]')).toEqual({ kind: 'done' });
    expect(interpretChatEventData(' [DONE]').kind).toBe('invalid-json');
  });

  it('parses content, role and finish_reason', () => {
    const item = interpretChatEventData(
      chunk([{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }]),
    );
    expect(item).toEqual({
      kind: 'chunk',
      chunk: {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'm',
        created: 1,
        usage: null,
        unknownKeys: [],
        choices: [
          {
            index: 0,
            role: 'assistant',
            content: 'Hi',
            refusal: null,
            toolCalls: [],
            finishReason: null,
          },
        ],
      },
    });
  });

  it('parses tool-call deltas', () => {
    const item = interpretChatEventData(
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'get', arguments: '{"a"' },
              },
            ],
          },
        },
      ]),
    );
    expect(item.kind === 'chunk' && item.chunk.choices[0]?.toolCalls).toEqual([
      { index: 0, id: 'call_1', type: 'function', name: 'get', arguments: '{"a"' },
    ]);
  });

  it('parses usage-only chunks', () => {
    const item = interpretChatEventData(
      chunk([], { usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }),
    );
    expect(item.kind === 'chunk' && item.chunk.usage).toEqual({
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    });
  });

  it('reports unknown keys without failing', () => {
    const item = interpretChatEventData(
      chunk([{ index: 0, delta: { content: 'x', reasoning_content: 'y' }, extra: 1 }], {
        provider: 'p',
      }),
    );
    expect(item.kind === 'chunk' && [...item.chunk.unknownKeys].sort()).toEqual([
      'choices[].delta.reasoning_content',
      'choices[].extra',
      'provider',
    ]);
  });

  it('parses error payloads', () => {
    expect(
      interpretChatEventData(
        JSON.stringify({ error: { message: 'boom', type: 'server_error', code: 500 } }),
      ),
    ).toEqual({
      kind: 'error',
      error: { message: 'boom', type: 'server_error', code: '500' },
    });
    expect(interpretChatEventData(JSON.stringify({ error: 'plain' }))).toEqual({
      kind: 'error',
      error: { message: 'plain', type: null, code: null },
    });
  });

  it('classifies invalid and unrecognised JSON', () => {
    expect(interpretChatEventData('{"choices":[').kind).toBe('invalid-json');
    expect(interpretChatEventData('42')).toEqual({ kind: 'unrecognized', topLevelKeys: [] });
    expect(interpretChatEventData('{"hello":1}')).toEqual({
      kind: 'unrecognized',
      topLevelKeys: ['hello'],
    });
  });
});

function feed(acc: ChatStreamAccumulator, datas: string[]) {
  return datas.flatMap((d) => acc.apply(interpretChatEventData(d)));
}

describe('ChatStreamAccumulator', () => {
  it('assembles content and tool calls across fragments', () => {
    const acc = new ChatStreamAccumulator();
    const diags = feed(acc, [
      chunk([{ index: 0, delta: { role: 'assistant', content: '' } }]),
      chunk([{ index: 0, delta: { content: 'Hel' } }]),
      chunk([{ index: 0, delta: { content: 'lo' } }]),
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '' } },
            ],
          },
        },
      ]),
      chunk([
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } },
      ]),
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
      '[DONE]',
    ]);
    expect(diags).toEqual([]);
    expect(acc.verdict(true)).toEqual({ outcome: 'completed', completionSignal: 'done-marker' });
    expect(acc.finalize(true)).toEqual([]);
    expect(acc.assemble()).toEqual([
      {
        index: 0,
        role: 'assistant',
        content: 'Hello',
        contentLength: 5,
        refusal: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            index: 0,
            id: 'c1',
            type: 'function',
            name: 'f',
            arguments: '{"x":1}',
            argumentsLength: 7,
            argumentsValidJson: true,
            fragmentCount: 3,
          },
        ],
      },
    ]);
  });

  it('does not duplicate a tool name repeated on every fragment', () => {
    const acc = new ChatStreamAccumulator();
    feed(acc, [
      chunk([
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{' } }] },
        },
      ]),
      chunk([
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '}' } }] },
        },
      ]),
    ]);
    expect(acc.assemble()[0]?.toolCalls[0]?.name).toBe('f');
  });

  it('flags invalid assembled tool arguments', () => {
    const acc = new ChatStreamAccumulator();
    feed(acc, [
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"x":' } }],
          },
        },
      ]),
      chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]),
      '[DONE]',
    ]);
    expect(acc.finalize(true).map((d) => d.code)).toEqual(['chat-tool-arguments-invalid-json']);
  });

  it('reports protocol violations', () => {
    const acc = new ChatStreamAccumulator();
    const diags = feed(acc, [
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }]),
      chunk([{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }]),
      chunk([{ index: 0, delta: { content: 'late' } }]),
      '[DONE]',
      chunk([{ index: 0, delta: { content: 'after' } }]),
    ]);
    expect(diags.map((d) => d.code)).toEqual([
      'chat-tool-call-missing-header',
      'chat-delta-after-finish',
      'chat-event-after-done',
      'chat-delta-after-finish',
    ]);
  });

  it('reports unknown keys once per stream', () => {
    const acc = new ChatStreamAccumulator();
    const diags = feed(acc, [
      chunk([{ index: 0, delta: { content: 'a', reasoning: 'r' } }]),
      chunk([{ index: 0, delta: { content: 'b', reasoning: 'r' } }]),
    ]);
    expect(diags.map((d) => d.code)).toEqual(['chat-unknown-keys']);
  });

  it('treats a clean EOF with all finish_reasons as completed', () => {
    const acc = new ChatStreamAccumulator();
    feed(acc, [chunk([{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }])]);
    expect(acc.verdict(true)).toEqual({ outcome: 'completed', completionSignal: 'finish-reason' });
    expect(acc.verdict(false)).toEqual({ outcome: 'incomplete', completionSignal: null });
    expect(acc.finalize(true)).toEqual([
      expect.objectContaining({ code: 'chat-missing-terminator', severity: 'info' }),
    ]);
  });

  it('treats EOF without finish_reason or [DONE] as incomplete', () => {
    const acc = new ChatStreamAccumulator();
    feed(acc, [chunk([{ index: 0, delta: { content: 'x' } }])]);
    expect(acc.verdict(true).outcome).toBe('incomplete');
    expect(acc.finalize(true)).toEqual([
      expect.objectContaining({ code: 'chat-missing-terminator', severity: 'error' }),
    ]);
  });

  it('reports in-stream errors', () => {
    const acc = new ChatStreamAccumulator();
    const diags = feed(acc, [
      JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }),
    ]);
    expect(diags.map((d) => d.code)).toEqual(['chat-stream-error']);
    expect(acc.verdict(true).outcome).toBe('stream-error');
  });

  it('keeps only lengths when payload retention is disabled', () => {
    const acc = new ChatStreamAccumulator({ retainPayloads: false });
    feed(acc, [chunk([{ index: 0, delta: { content: 'secret' }, finish_reason: 'stop' }])]);
    expect(acc.assemble()[0]).toMatchObject({ content: null, contentLength: 6 });
  });

  it('bounds retained characters', () => {
    const acc = new ChatStreamAccumulator({ maxRetainedChars: 4 });
    feed(acc, [chunk([{ index: 0, delta: { content: 'abcdef' } }])]);
    expect(acc.assemble()[0]).toMatchObject({ content: 'abcd', contentLength: 6 });
    expect(acc.retentionTruncated).toBe(true);
  });
});
