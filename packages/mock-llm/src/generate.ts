/**
 * Deterministic response generation.
 *
 * The same request always produces the same content, ids and event sequence.
 * The PRNG seed is a hash of the model and the message texts. Only `created`
 * reflects wall-clock time, as on a real server.
 *
 * Token usage reported by the mock is SYNTHETIC: `completion_tokens` is the
 * number of emitted deltas and `prompt_tokens` is the number of
 * whitespace-separated words in the prompt. Neither comes from a tokenizer
 * (DECISIONS.md D-015).
 */
import { mulberry32 } from '@tokenfault/core';
import type { ChatRequest, ChatTool } from './request.js';
import { messageText } from './request.js';

const SENTENCES = [
  'TokenFault mock response.',
  'This text is generated deterministically from your request.',
  'Streaming arrives as many small content deltas.',
  'Each delta is one SSE event, not one token.',
  'Unicode check: héllo, 世界, مرحبا, 🚀.',
  'Robust clients handle split frames and slow starts.',
  'Network chunks and SSE events are different things.',
  'Retries need idempotency and backoff.',
  'A missing [DONE] marker usually means a truncated stream.',
  'Timeouts should distinguish first byte from idle gaps.',
];

/** FNV-1a 32-bit hash. Used for deterministic seeding only. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function requestSeed(request: ChatRequest): number {
  return fnv1a(`${request.model}\u0000${request.messages.map(messageText).join('\u0000')}`);
}

/** Splits text into word-sized deltas that keep leading whitespace, like real model output. */
export function splitIntoDeltas(text: string): string[] {
  return text.match(/\s*\S+/gu) ?? [];
}

export function generateContent(seed: number): string {
  const rng = mulberry32(seed);
  const count = 3 + Math.floor(rng() * 3);
  const picked = [SENTENCES[0]!];
  // Always include the Unicode sentence so multi-byte handling is exercised.
  const pool = SENTENCES.slice(1);
  const unicodeIndex = pool.findIndex((s) => s.startsWith('Unicode'));
  const indices = new Set<number>([unicodeIndex]);
  while (indices.size < count) indices.add(Math.floor(rng() * pool.length));
  for (const i of [...indices].sort((a, b) => a - b)) picked.push(pool[i]!);
  return picked.join(' ');
}

const DEFAULT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a location.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        days: { type: 'integer' },
      },
    },
  },
};

/** Picks the tool to call, or `null` when the response should be plain content. */
export function selectTool(request: ChatRequest, forceTool: boolean): ChatTool | null {
  const tools = request.tools ?? [];
  const choice = request.tool_choice;
  if (choice === 'none' && !forceTool) return null;
  if (typeof choice === 'object') {
    const named = tools.find((t) => t.function.name === choice.function.name);
    if (named) return named;
  }
  if (tools.length > 0) return tools[0]!;
  return forceTool ? DEFAULT_TOOL : null;
}

/** Builds deterministic example arguments from a (subset of) JSON Schema. */
export function exampleArguments(tool: ChatTool): string {
  const props = tool.function.parameters?.properties ?? {};
  const args: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(props).slice(0, 16))
    args[name] = exampleValue(raw, name);
  return JSON.stringify(args);
}

function exampleValue(schema: unknown, name: string): unknown {
  if (typeof schema !== 'object' || schema === null) return null;
  const s = schema as { type?: unknown; enum?: unknown };
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0] as unknown;
  switch (s.type) {
    case 'string':
      return name === 'location' ? 'Paris, France' : `example ${name}`;
    case 'integer':
      return 3;
    case 'number':
      return 3.5;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

export function chunkString(text: string, size: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

export function syntheticPromptTokens(request: ChatRequest): number {
  return request.messages.reduce((n, m) => n + (messageText(m).match(/\S+/g)?.length ?? 0), 0);
}
