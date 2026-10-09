/**
 * Header forwarding rules (RFC 9110 §7.6.1 hop-by-hop handling plus TokenFault policy).
 */
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { HEADER_PREFIX } from '@tokenfault/shared';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request headers never forwarded upstream (besides hop-by-hop and `x-tokenfault-*`). */
const DROP_REQUEST = new Set([
  'host',
  'content-length',
  'accept-encoding',
  'expect',
  'http2-settings',
]);

/** Response headers never forwarded to the client. */
const DROP_RESPONSE = new Set(['strict-transport-security', 'alt-svc', 'content-length']);

function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0),
  );
}

/**
 * Headers sent upstream. `Authorization` and other credentials are forwarded
 * unchanged (the client is talking to its own provider) but are never logged
 * or captured. `accept-encoding: identity` keeps the stream inspectable
 * (DECISIONS.md D-006).
 */
export function forwardRequestHeaders(
  incoming: IncomingHttpHeaders,
  bodyLength: number,
): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      listed.has(lower) ||
      DROP_REQUEST.has(lower) ||
      lower.startsWith(HEADER_PREFIX)
    )
      continue;
    out[lower] = value;
  }
  out['accept-encoding'] = 'identity';
  if (bodyLength > 0) out['content-length'] = bodyLength;
  return out;
}

/**
 * Headers sent to the client. `content-length` is always dropped because the
 * body is streamed with chunked encoding (faults may change its length);
 * HSTS and Alt-Svc are dropped because they are meaningless for a local proxy.
 */
export function forwardResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = connectionListed(incoming);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      listed.has(lower) ||
      DROP_RESPONSE.has(lower) ||
      lower.startsWith(HEADER_PREFIX)
    )
      continue;
    out[lower] = value;
  }
  return out;
}
