/**
 * A measuring streaming HTTP client.
 *
 * Built on `node:http`/`node:https` rather than `fetch`, so it can tell a TCP
 * reset from a premature close and a clean end, and record every network
 * chunk with a timestamp. Results are inspected with the same
 * `StreamInspector` the proxy uses.
 */
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { StreamInspector } from '../inspector/stream-inspector.js';
import type { InspectorSnapshot, InspectorUpdate } from '../inspector/stream-inspector.js';
import { describeError } from '@tokenfault/shared';
import type {
  CapturedChunk,
  CapturedEvent,
  Diagnostic,
  Termination,
  TerminationKind,
} from '@tokenfault/shared';

export interface StreamRequestOptions {
  readonly method?: string;
  readonly headers?: OutgoingHttpHeaders;
  /** Request body. Objects are JSON-encoded. */
  readonly body?: string | Uint8Array | Record<string, unknown>;
  readonly signal?: AbortSignal;
  /** Abort if the whole exchange takes longer. Default 30 s. */
  readonly timeoutMs?: number;
  readonly capturePayloads?: boolean;
  /** Maximum raw body bytes retained in `body` (later bytes are still inspected). Default 64 MiB. */
  readonly maxBodyBytes?: number;
  /** Called with newly decoded events/diagnostics as they arrive (for live display). */
  readonly onUpdate?: (update: InspectorUpdate, atMs: number) => void;
  /** Called once response headers arrive. */
  readonly onHeaders?: (status: number, headers: IncomingMessage['headers'], atMs: number) => void;
}

export interface StreamResult {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly snapshot: InspectorSnapshot;
  readonly events: readonly CapturedEvent[];
  readonly chunks: readonly CapturedChunk[];
  readonly diagnostics: readonly Diagnostic[];
  readonly termination: Termination;
  /** Concatenated content of choice 0 (empty if none). */
  readonly text: string;
  /** Raw body bytes as received (all chunks concatenated, up to `maxBodyBytes`). */
  readonly body: Uint8Array;
  /** True if the body exceeded `maxBodyBytes` and `body` holds only its beginning. */
  readonly bodyTruncated: boolean;
  /** The inspector that processed the response (e.g. to build a recording). */
  readonly inspector: StreamInspector;
}

/** Sends a request and consumes the full response, recording timing and transport behaviour. */
export function streamRequest(
  url: string | URL,
  options: StreamRequestOptions = {},
): Promise<StreamResult> {
  const target = typeof url === 'string' ? new URL(url) : url;
  const body = encodeBody(options.body);
  const headers: OutgoingHttpHeaders = { ...options.headers };
  if (
    body &&
    options.body !== undefined &&
    !(options.body instanceof Uint8Array) &&
    typeof options.body !== 'string'
  ) {
    headers['content-type'] ??= 'application/json';
  }
  if (body) headers['content-length'] = body.length;

  const inspector = new StreamInspector({ capturePayloads: options.capturePayloads ?? true });
  const received: Uint8Array[] = [];
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024 * 1024;
  let receivedBytes = 0;
  let bodyTruncated = false;
  const started = performance.now();
  const now = (): number => performance.now() - started;
  const controller = new AbortController();
  const signals = [controller.signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  return new Promise<StreamResult>((resolve) => {
    let status: number | null = null;
    let responseHeaders: IncomingMessage['headers'] = {};
    let settled = false;

    const finish = (kind: TerminationKind, detail: string | null): void => {
      if (settled) return;
      settled = true;
      const termination: Termination = { kind, atMs: now(), detail };
      const last = inspector.onEnd(termination);
      options.onUpdate?.(last, termination.atMs);
      const snapshot = inspector.snapshot();
      resolve({
        status,
        headers: responseHeaders,
        snapshot,
        events: inspector.events,
        chunks: inspector.chunks,
        diagnostics: inspector.diagnostics,
        termination,
        text: snapshot.choices[0]?.content ?? '',
        body: concat(received),
        bodyTruncated,
        inspector,
      });
    };

    const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(target, {
      method: options.method ?? (body ? 'POST' : 'GET'),
      headers,
      signal,
    });

    req.on('response', (res) => {
      status = res.statusCode ?? null;
      responseHeaders = res.headers;
      const headersAt = now();
      inspector.onHeaders(res.statusCode ?? 0, res.headers, headersAt);
      options.onHeaders?.(res.statusCode ?? 0, res.headers, headersAt);
      res.on('data', (chunk: Buffer) => {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
        if (receivedBytes + bytes.length <= maxBodyBytes) {
          received.push(bytes);
          receivedBytes += bytes.length;
        } else {
          bodyTruncated = true;
        }
        const at = now();
        const update = inspector.onChunk(bytes, at);
        if (update.events.length > 0 || update.diagnostics.length > 0)
          options.onUpdate?.(update, at);
      });
      res.on('end', () => finish('eof', null));
      res.on('error', (error) => finish(classify(error, signal), describeError(error)));
      res.on('close', () => {
        if (!res.complete)
          finish(
            signal.aborted ? 'client-abort' : 'upstream-reset',
            'response closed before completion',
          );
      });
    });
    req.on('error', (error) => {
      if (status === null && !signal.aborted) {
        finish('upstream-unreachable', describeError(error));
      } else {
        finish(classify(error, signal), describeError(error));
      }
    });
    req.end(body ?? undefined);
  });
}

function classify(_error: unknown, signal: AbortSignal): TerminationKind {
  return signal.aborted ? 'client-abort' : 'upstream-reset';
}

function encodeBody(body: StreamRequestOptions['body']): Buffer | null {
  if (body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
