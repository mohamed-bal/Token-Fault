/**
 * Redaction helpers.
 *
 * TokenFault sits in the path of API keys and prompts. These helpers are
 * applied to everything that leaves the request-handling path: logs,
 * captured sessions, recordings and the Studio API. They follow a
 * deny-by-default approach. Header capture is allowlist-based, and
 * free-form text is scrubbed of well-known credential shapes.
 */

export const REDACTED = '[redacted]';

/** Header-name fragments that always mark a header as sensitive. */
const SENSITIVE_HEADER_FRAGMENTS = [
  'authorization',
  'cookie',
  'api-key',
  'apikey',
  'token',
  'secret',
  'password',
  'session',
  'signature',
  'credential',
] as const;

/** Exact header names that are sensitive but do not match a fragment. */
const SENSITIVE_HEADER_NAMES = new Set(['x-api-key', 'openai-organization', 'openai-project']);

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  return SENSITIVE_HEADER_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Response headers worth capturing for diagnostics. Anything else is dropped
 * from captures, and a captured header that is also sensitive is still redacted.
 */
const CAPTURABLE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'cache-control',
  'retry-after',
  'x-request-id',
  'request-id',
  'openai-processing-ms',
  'openai-version',
  'openai-model',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
]);

export type HeaderInput = Readonly<Record<string, string | readonly string[] | number | undefined>>;

/**
 * Produces a capture-safe header map: only allowlisted names are kept,
 * values are joined, and sensitive names are redacted.
 */
export function captureResponseHeaders(headers: HeaderInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (!CAPTURABLE_RESPONSE_HEADERS.has(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
    out[name] = isSensitiveHeader(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Returns the request path with every query-string value redacted. Some
 * OpenAI-compatible providers accept API keys as query parameters. Parameter
 * names are kept because they are useful for debugging.
 */
export function redactPathQuery(pathWithQuery: string): string {
  const q = pathWithQuery.indexOf('?');
  if (q === -1) return pathWithQuery;
  const path = pathWithQuery.slice(0, q);
  const query = pathWithQuery.slice(q + 1);
  if (query.length === 0) return path;
  const redacted = query
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      const name = eq === -1 ? part : part.slice(0, eq);
      return eq === -1 ? name : `${name}=${REDACTED}`;
    })
    .join('&');
  return `${path}?${redacted}`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI-style and many compatible providers' secret keys.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens in free text.
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // Google-style API keys.
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // Generic "api_key=..." / "apikey: ..." fragments.
  /\b(api[_-]?key|access[_-]?token|secret)(["']?\s*[:=]\s*["']?)[^\s"'&,;]{6,}/gi,
];

/** Scrubs well-known credential shapes from free-form text such as error messages. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match: string, name?: string, sep?: string) =>
      typeof name === 'string' && typeof sep === 'string' ? `${name}${sep}${REDACTED}` : REDACTED,
    );
  }
  return out;
}

/** The subset of WHATWG `URL` used here (keeps this package free of DOM/Node typings). */
export interface UrlLike {
  readonly protocol: string;
  readonly host: string;
  readonly pathname: string;
}

/** Returns `url` without username/password, query string or fragment. Used whenever a target URL is displayed. */
export function describeUrlSafely(url: UrlLike): string {
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}
