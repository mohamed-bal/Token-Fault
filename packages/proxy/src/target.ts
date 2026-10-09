/**
 * Upstream target handling.
 *
 * The upstream is fixed when the server starts and is never derived from an
 * incoming request. That makes it impossible to use the proxy as an open
 * proxy or as an SSRF pivot. Request paths are appended to the configured base
 * path, and the result is checked to stay on the same origin and under the
 * same base path (dot segments, including percent-encoded ones, are
 * normalised by the WHATWG URL parser before the check).
 */
import { describeUrlSafely } from '@tokenfault/shared';

export interface UpstreamTarget {
  readonly url: URL;
  /** Base path without trailing slash ('' for the root). */
  readonly basePath: string;
  /** Credential-free display form. */
  readonly display: string;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

export function parseTarget(raw: string): UpstreamTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetError(`Invalid target URL: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetError(`Target must use http or https, got "${url.protocol}"`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new TargetError(
      'Target URL must not contain credentials; send them as request headers from your client',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TargetError('Target URL must not contain a query string or fragment');
  }
  if (url.hostname === '') throw new TargetError('Target URL has no host');
  const basePath = url.pathname.replace(/\/+$/, '');
  return { url, basePath, display: describeUrlSafely(url) };
}

/** True if the request target contains a control character, a backslash or a fragment marker. */
function hasForbiddenChar(target: string): boolean {
  for (let i = 0; i < target.length; i++) {
    const code = target.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x5c /* \\ */ || code === 0x23 /* # */)
      return true;
  }
  return false;
}

/**
 * Builds the upstream URL for an incoming request target (origin-form, e.g.
 * `/v1/chat/completions?x=1`). Returns `null` if the request target is not
 * acceptable or would escape the target origin/base path.
 */
export function buildUpstreamUrl(target: UpstreamTarget, requestTarget: string): URL | null {
  if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) return null;
  if (hasForbiddenChar(requestTarget)) return null;
  // Encoded slashes/backslashes are never needed by OpenAI-compatible APIs, and some
  // upstream servers decode them before routing, which would bypass the base-path check.
  const pathPart = requestTarget.split('?', 1)[0] ?? '';
  if (/%2f|%5c/i.test(pathPart)) return null;
  let url: URL;
  try {
    url = new URL(`${target.url.origin}${target.basePath}${requestTarget}`);
  } catch {
    return null;
  }
  if (url.origin !== target.url.origin) return null;
  if (
    target.basePath !== '' &&
    url.pathname !== target.basePath &&
    !url.pathname.startsWith(`${target.basePath}/`)
  ) {
    return null;
  }
  return url;
}
