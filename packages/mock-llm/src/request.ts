/**
 * Validation of the subset of the Chat Completions request the mock supports.
 * Unknown top-level parameters (temperature, top_p, ...) are accepted and
 * ignored, as real OpenAI-compatible servers do. Structurally invalid input is
 * rejected with an OpenAI-style 400 error.
 */
import { z } from 'zod';

const ContentPart = z.looseObject({
  type: z.string().max(64),
  text: z.string().max(1_000_000).optional(),
});

const Message = z.looseObject({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: z.union([z.string().max(1_000_000), z.array(ContentPart).max(256), z.null()]).optional(),
  name: z.string().max(256).optional(),
});

const JsonSchemaLike = z.looseObject({
  type: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  enum: z.array(z.unknown()).optional(),
});

const Tool = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: z.string().max(4_096).optional(),
    parameters: JsonSchemaLike.optional(),
  }),
});

export const ChatRequestSchema = z.looseObject({
  model: z.string().min(1).max(256),
  messages: z.array(Message).min(1).max(1_000),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullable().optional(),
  tools: z.array(Tool).max(128).optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.looseObject({
        type: z.literal('function'),
        function: z.looseObject({ name: z.string().max(64) }),
      }),
    ])
    .optional(),
  n: z.number().int().min(1).optional(),
  max_tokens: z.number().int().min(1).max(100_000).nullable().optional(),
  max_completion_tokens: z.number().int().min(1).max(100_000).nullable().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatTool = z.infer<typeof Tool>;

export function messageText(message: ChatRequest['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => p.text ?? '').join(' ');
  return '';
}
