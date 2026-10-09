/**
 * A reference streaming chat-completions client that handles the failure
 * modes TokenFault injects. It uses only `fetch` and the TokenFault SSE
 * decoder; copy the patterns, not necessarily the code.
 *
 * Policy:
 * - Separate timeouts for the first byte and for idle gaps between chunks.
 * - A stream counts as complete only after `[DONE]` or a finish_reason. A clean
 *   TCP close is not enough.
 * - 429 and 503 before streaming are retried with backoff, honouring Retry-After.
 * - Failures after content has started are NOT retried silently. The caller
 *   decides, because retrying generates a different response.
 */
import { ChatStreamAccumulator, SseDecoder, interpretChatEventData } from '@tokenfault/core';

export type StreamErrorKind =
  'http' | 'first-byte-timeout' | 'idle-timeout' | 'incomplete' | 'stream-error' | 'network';

export class StreamError extends Error {
  // Plain fields (no constructor parameter properties) so Node can run this file with type stripping.
  readonly kind: StreamErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    kind: StreamErrorKind,
    message: string,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'StreamError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ResilientChatOptions {
  readonly baseUrl: string;
  readonly model?: string;
  readonly prompt: string;
  readonly headers?: Record<string, string>;
  readonly firstByteTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly onDelta?: (text: string) => void;
  readonly signal?: AbortSignal;
}

export interface ResilientChatResult {
  readonly text: string;
  readonly attempts: number;
  readonly finishReason: string | null;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(date - Date.now(), 60_000));
}

async function attempt(
  options: ResilientChatOptions,
): Promise<ResilientChatResult & { attempts: 1 }> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let timeoutKind: 'first-byte-timeout' | 'idle-timeout' | null = null;
  let timer = setTimeout(() => {
    timeoutKind = 'first-byte-timeout';
    controller.abort();
  }, options.firstByteTimeoutMs ?? 30_000);
  const armIdle = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutKind = 'idle-timeout';
      controller.abort();
    }, options.idleTimeoutMs ?? 60_000);
  };

  try {
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...options.headers,
        },
        body: JSON.stringify({
          model: options.model ?? 'tokenfault-mock-1',
          stream: true,
          messages: [{ role: 'user', content: options.prompt }],
        }),
        signal,
      });
    } catch (error) {
      if (timeoutKind)
        throw new StreamError(
          timeoutKind,
          `No response within ${options.firstByteTimeoutMs ?? 30_000} ms`,
        );
      throw new StreamError(
        'network',
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new StreamError(
        'http',
        `HTTP ${response.status}`,
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    const decoder = new SseDecoder();
    const accumulator = new ChatStreamAccumulator();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    armIdle();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (timeoutKind)
          throw new StreamError(
            timeoutKind,
            `Stream ${timeoutKind === 'idle-timeout' ? 'idle' : 'silent'} for too long`,
          );
        throw new StreamError(
          'incomplete',
          `Stream broke: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (chunk.done) break;
      armIdle();
      for (const item of decoder.push(chunk.value)) {
        if (item.kind !== 'event') continue;
        const interpreted = interpretChatEventData(item.event.data);
        accumulator.apply(interpreted);
        if (interpreted.kind === 'error')
          throw new StreamError('stream-error', interpreted.error.message);
        if (interpreted.kind === 'chunk') {
          for (const c of interpreted.chunk.choices) if (c.content) options.onDelta?.(c.content);
        }
      }
    }
    decoder.end();
    const verdict = accumulator.verdict(true);
    const choice = accumulator.assemble()[0];
    if (verdict.outcome !== 'completed') {
      throw new StreamError(
        'incomplete',
        'Stream ended without [DONE] or finish_reason (truncated response)',
      );
    }
    return { text: choice?.content ?? '', attempts: 1, finishReason: choice?.finishReason ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/** Streams a chat completion, retrying only failures that happen before any content arrived. */
export async function resilientChat(options: ResilientChatOptions): Promise<ResilientChatResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let n = 1; ; n++) {
    let sawContent = false;
    try {
      const result = await attempt({
        ...options,
        onDelta: (t) => {
          sawContent = true;
          options.onDelta?.(t);
        },
      });
      return { ...result, attempts: n };
    } catch (error) {
      const retryable =
        error instanceof StreamError &&
        !sawContent &&
        ((error.kind === 'http' && (error.status === 429 || error.status === 503)) ||
          error.kind === 'network' ||
          error.kind === 'first-byte-timeout');
      if (!retryable || n >= maxAttempts) throw error;
      const backoff = error.retryAfterMs ?? (options.baseBackoffMs ?? 250) * 2 ** (n - 1);
      await sleep(backoff, options.signal);
    }
  }
}
