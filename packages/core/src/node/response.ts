/**
 * Node.js transport adapters for writing streamed responses with explicit
 * backpressure and deliberate, mode-specific connection termination.
 */
import type { ServerResponse } from 'node:http';
import type { DisconnectMode } from '../faults/schema.js';

/** Thrown when the client connection closed while a write was pending. */
export class ClientGoneError extends Error {
  constructor() {
    super('Client connection closed');
    this.name = 'ClientGoneError';
  }
}

/**
 * Writes `bytes` and resolves once the socket accepts more data. If the
 * kernel buffer is full (`write()` returned false), the promise waits for
 * `drain`, so a slow client throttles the producer instead of growing memory.
 */
export function writeWithBackpressure(res: ServerResponse, bytes: Uint8Array): Promise<void> {
  if (res.destroyed || res.writableEnded) return Promise.reject(new ClientGoneError());
  if (bytes.length === 0) return Promise.resolve();
  if (res.write(bytes)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new ClientGoneError());
    };
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

/**
 * Terminates a streaming response.
 *
 * - `end`: finishes the HTTP response properly (terminating chunk). The client sees a clean EOF.
 * - `destroy`: closes the socket without finishing the response. The client sees a premature close.
 * - `reset`: sends a TCP RST. The client sees ECONNRESET.
 */
export function terminateResponse(res: ServerResponse, mode: DisconnectMode): void {
  if (res.destroyed) return;
  switch (mode) {
    case 'end':
      if (!res.writableEnded) res.end();
      return;
    case 'destroy':
      res.destroy();
      return;
    case 'reset': {
      const socket = res.socket;
      if (!socket || typeof socket.resetAndDestroy !== 'function' || socket.destroyed) {
        res.destroy();
        return;
      }
      // An RST discards data still queued in the socket. The fault contract is "reset AFTER the
      // bytes written so far", so pending user-space writes are flushed first. On Windows the
      // kernel also drops unsent/unread data on RST, so a short grace period follows there.
      const reset = (): void => {
        if (!socket.destroyed) socket.resetAndDestroy();
      };
      const afterFlush = (): void => {
        if (process.platform === 'win32') setTimeout(reset, 15).unref();
        else reset();
      };
      if (socket.writableLength === 0) {
        afterFlush();
      } else {
        const fallback = setTimeout(reset, 1_000);
        fallback.unref();
        socket.once('drain', () => {
          clearTimeout(fallback);
          afterFlush();
        });
      }
      return;
    }
  }
}

/**
 * Ends a response and resolves once it finished OR the connection closed. `res.end(cb)` alone
 * never calls back if the socket was destroyed before `'close'` was emitted, which would leave
 * the caller waiting forever.
 */
export function endResponse(res: ServerResponse): Promise<void> {
  if (res.destroyed || res.writableFinished) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('finish', done);
      res.off('close', done);
      resolve();
    };
    res.once('finish', done);
    res.once('close', done);
    if (!res.writableEnded) res.end();
  });
}
