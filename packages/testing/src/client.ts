/**
 * Chat-completions convenience wrappers around the measuring client in
 * `@tokenfault/core/node`.
 */
import type { OutgoingHttpHeaders } from 'node:http';
import { streamRequest } from '@tokenfault/core/node';
import type { StreamRequestOptions, StreamResult } from '@tokenfault/core/node';

export { streamRequest };
export type { StreamRequestOptions, StreamResult };

export interface ChatRequestOptions extends Omit<StreamRequestOptions, 'body' | 'method'> {
  readonly model?: string;
  readonly prompt?: string;
  readonly stream?: boolean;
  readonly includeUsage?: boolean;
  readonly tools?: readonly unknown[];
  readonly scenario?: string;
  readonly faults?: unknown;
  /** Extra body fields merged into the request. */
  readonly extraBody?: Record<string, unknown>;
}

/** Convenience wrapper for `POST {baseUrl}/v1/chat/completions`. */
export function streamChatCompletion(
  baseUrl: string,
  options: ChatRequestOptions = {},
): Promise<StreamResult> {
  const headers: OutgoingHttpHeaders = { ...options.headers };
  if (options.scenario) headers['x-tokenfault-scenario'] = options.scenario;
  if (options.faults !== undefined) headers['x-tokenfault-faults'] = JSON.stringify(options.faults);
  const body: Record<string, unknown> = {
    model: options.model ?? 'tokenfault-mock-1',
    messages: [
      { role: 'user', content: options.prompt ?? 'Hello from the TokenFault test suite.' },
    ],
    stream: options.stream ?? true,
    ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...options.extraBody,
  };
  const {
    model: _m,
    prompt: _p,
    stream: _s,
    includeUsage: _u,
    tools: _t,
    scenario: _sc,
    faults: _f,
    extraBody: _e,
    ...rest
  } = options;
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return streamRequest(`${base}/v1/chat/completions`, { ...rest, headers, body });
}
