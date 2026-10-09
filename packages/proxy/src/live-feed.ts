/**
 * Studio live feed: an SSE stream of store changes.
 *
 * Each subscriber's outbound buffer is bounded. If a subscriber cannot keep up
 * (its socket buffer exceeds `maxBufferBytes`), it is disconnected rather
 * than letting memory grow. The Studio reconnects and starts from a fresh
 * snapshot.
 */
import type { ServerResponse } from 'node:http';
import { serializeSseComment, serializeSseEvent } from '@tokenfault/core';
import type { LiveMessage } from '@tokenfault/shared';
import type { SessionStore } from './session-store.js';

export interface LiveFeedOptions {
  readonly maxBufferBytes: number;
  readonly heartbeatMs?: number;
  /**
   * Re-checked before every write. When it returns false (the Studio signed out or its
   * session expired), the stream is closed without sending anything more (SEC-R1).
   */
  readonly isAuthorized?: () => boolean;
  /** Extra response headers (the control plane's security headers). */
  readonly headers?: Readonly<Record<string, string>>;
}

export function serveLiveFeed(
  res: ServerResponse,
  store: SessionStore,
  options: LiveFeedOptions,
): void {
  res.writeHead(200, {
    ...options.headers,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    'x-content-type-options': 'nosniff',
  });
  res.flushHeaders();

  let closed = false;
  const send = (text: string): void => {
    if (closed) return;
    if (options.isAuthorized && !options.isAuthorized()) {
      cleanup();
      res.destroy();
      return;
    }
    if (res.writableLength > options.maxBufferBytes) {
      cleanup();
      res.destroy();
      return;
    }
    res.write(text);
  };
  const sendMessage = (message: LiveMessage): void =>
    send(serializeSseEvent({ data: JSON.stringify(message) }));

  sendMessage({ type: 'snapshot', sessions: store.list() });
  const unsubscribe = store.subscribe(sendMessage);
  const heartbeat = setInterval(
    () => send(serializeSseComment('ping')),
    options.heartbeatMs ?? 15_000,
  );

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  }
  // Note: IncomingMessage 'close' fires once the request is read, not on disconnect.
  res.on('close', cleanup);
}
