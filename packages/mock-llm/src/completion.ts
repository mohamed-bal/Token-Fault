import { serializeSseEvent } from '@tokenfault/core';
import type { ChatRequest } from './request.js';
import {
  chunkString,
  exampleArguments,
  fnv1a,
  generateContent,
  requestSeed,
  selectTool,
  splitIntoDeltas,
  syntheticPromptTokens,
} from './generate.js';

export interface CompletionOptions {
  /** Force a tool call (fragment-tool-calls scenario). */
  readonly forceTool: boolean;
  /** Characters per tool-arguments fragment. */
  readonly toolChunkChars: number;
  /** Unix seconds for `created`. */
  readonly created: number;
}

export interface CompletionPlan {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly content: string | null;
  readonly contentDeltas: readonly string[];
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
    readonly fragments: readonly string[];
  } | null;
  readonly finishReason: 'stop' | 'length' | 'tool_calls';
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

const SYSTEM_FINGERPRINT = 'tokenfault-mock';

export function planCompletion(request: ChatRequest, options: CompletionOptions): CompletionPlan {
  const seed = requestSeed(request);
  const id = `chatcmpl-tf${seed.toString(16).padStart(8, '0')}`;
  const tool = selectTool(request, options.forceTool);
  const promptTokens = syntheticPromptTokens(request);

  if (tool) {
    const args = exampleArguments(tool);
    const fragments = chunkString(args, options.toolChunkChars);
    return {
      id,
      model: request.model,
      created: options.created,
      content: null,
      contentDeltas: [],
      toolCall: {
        id: `call_tf${fnv1a(`${id}:${tool.function.name}`).toString(16)}`,
        name: tool.function.name,
        arguments: args,
        fragments,
      },
      finishReason: 'tool_calls',
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: fragments.length,
        total_tokens: promptTokens + fragments.length,
      },
    };
  }

  const limit = request.max_completion_tokens ?? request.max_tokens ?? null;
  let deltas = splitIntoDeltas(generateContent(seed));
  let finishReason: CompletionPlan['finishReason'] = 'stop';
  if (limit !== null && deltas.length > limit) {
    deltas = deltas.slice(0, limit);
    finishReason = 'length';
  }
  return {
    id,
    model: request.model,
    created: options.created,
    content: deltas.join(''),
    contentDeltas: deltas,
    toolCall: null,
    finishReason,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: deltas.length,
      total_tokens: promptTokens + deltas.length,
    },
  };
}

function chunkJson(
  plan: CompletionPlan,
  choices: unknown[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: plan.id,
    object: 'chat.completion.chunk',
    created: plan.created,
    model: plan.model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices,
    ...extra,
  });
}

/** Serialises the full stream as SSE frames (one frame per event). */
export function streamFrames(plan: CompletionPlan, includeUsage: boolean): string[] {
  const frames: string[] = [];
  const delta = (d: Record<string, unknown>, finish: string | null = null) =>
    serializeSseEvent({
      data: chunkJson(plan, [{ index: 0, delta: d, logprobs: null, finish_reason: finish }]),
    });

  frames.push(delta({ role: 'assistant', content: plan.toolCall ? null : '', refusal: null }));
  if (plan.toolCall) {
    const call = plan.toolCall;
    frames.push(
      delta({
        tool_calls: [
          { index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
        ],
      }),
    );
    for (const fragment of call.fragments)
      frames.push(delta({ tool_calls: [{ index: 0, function: { arguments: fragment } }] }));
  } else {
    for (const content of plan.contentDeltas) frames.push(delta({ content }));
  }
  frames.push(delta({}, plan.finishReason));
  if (includeUsage)
    frames.push(serializeSseEvent({ data: chunkJson(plan, [], { usage: plan.usage }) }));
  frames.push(serializeSseEvent({ data: '[DONE]' }));
  return frames;
}

/** Non-streaming `chat.completion` response body. */
export function completionBody(plan: CompletionPlan): unknown {
  return {
    id: plan.id,
    object: 'chat.completion',
    created: plan.created,
    model: plan.model,
    system_fingerprint: SYSTEM_FINGERPRINT,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: plan.content,
          refusal: null,
          ...(plan.toolCall
            ? {
                tool_calls: [
                  {
                    id: plan.toolCall.id,
                    type: 'function',
                    function: { name: plan.toolCall.name, arguments: plan.toolCall.arguments },
                  },
                ],
              }
            : {}),
        },
        logprobs: null,
        finish_reason: plan.finishReason,
      },
    ],
    usage: plan.usage,
  };
}
