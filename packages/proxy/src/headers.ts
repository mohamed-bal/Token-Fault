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
  method = 'POST',
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
  // Explicit length for every body-carrying method, so an empty body is not sent chunked.
  if (bodyLength > 0 || method === 'POST' || method === 'PUT' || method === 'PATCH')
    out['content-length'] = bodyLength;
  return out;
}

/**
 * Headers sent to the client. `content-length` is always dropped because the
 * body is streamed with chunked encoding (faults may change its length);
 * HSTS and Alt-Svc are dropped because they are meaningless for a local proxy.
 */
/**
 * Added to every forwarded response. The proxy shares its origin with the Studio and the
 * control API, so upstream content must never be able to run as a same-origin document:
 * `sandbox` gives any HTML an opaque origin (its requests then fail the control-plane Origin
 * check), and `nosniff` stops content-type sniffing. These headers only affect documents
 * rendered by a browser, not API clients.
 */
export const RESPONSE_ISOLATION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': "sandbox; default-src 'none'",
  'x-content-type-options': 'nosniff',
});

/**
 * True for an upstream `Set-Cookie` that could interfere with the Studio session: the control
 * cookie's name, or any cookie scoped to the control prefix (SEC-R3).
 */
function targetsControlCookie(setCookie: string): boolean {
  const name = setCookie.slice(0, Math.max(0, setCookie.indexOf('='))).trim();
  return name === 'tf_session' || /;\s*path\s*=\s*\/__tokenfault/i.test(setCookie);
}

/** Security headers for every control-plane and Studio response (including the live feed). */
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
} as const;

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
    if (lower === 'set-cookie') {
      const kept = (Array.isArray(value) ? value : [String(value)]).filter(
        (c) => !targetsControlCookie(c),
      );
      if (kept.length > 0) out[lower] = kept;
      continue;
    }
    out[lower] = value;
  }
  // An upstream CSP is kept: comma-separated policies are all enforced (they intersect), so
  // appending ours only restricts further.
  const isolation =
    RESPONSE_ISOLATION_HEADERS['content-security-policy'] ?? "sandbox; default-src 'none'";
  const upstreamCsp = out['content-security-policy'];
  out['content-security-policy'] = upstreamCsp ? `${String(upstreamCsp)}, ${isolation}` : isolation;
  out['x-content-type-options'] = 'nosniff';
  return out;
}
