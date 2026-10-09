/**
 * Control-plane authentication (DECISIONS.md D-021).
 *
 * - One random 256-bit control token per server run (or one supplied by the operator).
 * - Programmatic clients (CLI, testing helpers, scripts) send `Authorization: Bearer <token>`.
 * - The Studio exchanges the token once (`POST /__tokenfault/api/auth/login`) for a random
 *   session id kept in an HttpOnly, SameSite=Strict cookie scoped to `/__tokenfault`. The token
 *   is never put in a URL, in localStorage or in static assets.
 * - Comparisons are constant-time over SHA-256 digests. Failed logins are rate-limited.
 *
 * The token protects the control API (captured completions, fault control, replay) from other
 * local processes and users. Loopback-only access, Host checks and Origin checks still apply.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const SESSION_COOKIE = 'tf_session';
export const MIN_TOKEN_LENGTH = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 10;

export function generateControlToken(): string {
  return randomBytes(32).toString('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string equality (length is hidden by hashing first). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export type LoginResult =
  | { readonly ok: true; readonly sessionId: string; readonly maxAgeSeconds: number }
  | { readonly ok: false; readonly reason: 'invalid' | 'rate-limited' };

export class ControlAuth {
  private readonly sessions = new Map<string, number>();
  private failures: number[] = [];

  constructor(
    private readonly token: string,
    private readonly now: () => number = Date.now,
  ) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new RangeError(`control token must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
  }

  /** True if the request carries a valid bearer token or session cookie. */
  isAuthenticated(headers: IncomingHttpHeaders): boolean {
    const authorization = headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      if (safeEqual(authorization.slice(7).trim(), this.token)) return true;
    }
    // Every `tf_session` value counts: another page on 127.0.0.1 (cookies ignore ports) can
    // plant a same-named cookie with a more specific path that sorts first (SEC-R3).
    return readCookies(headers.cookie, SESSION_COOKIE).some((id) => this.isValidSession(id));
  }

  login(candidate: string): LoginResult {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < FAILURE_WINDOW_MS);
    // The correct token always signs in: the limiter only throttles wrong guesses, so another
    // local process cannot lock the user out by failing on purpose (SEC-R2). Guessing a
    // 256-bit token stays infeasible either way.
    const valid = safeEqual(candidate, this.token);
    if (!valid && this.failures.length >= MAX_FAILURES_PER_WINDOW)
      return { ok: false, reason: 'rate-limited' };
    if (!valid) {
      this.failures.push(t);
      return { ok: false, reason: 'invalid' };
    }
    this.prune(t);
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, t + SESSION_TTL_MS);
    return { ok: true, sessionId, maxAgeSeconds: SESSION_TTL_MS / 1000 };
  }

  logout(headers: IncomingHttpHeaders): void {
    for (const id of readCookies(headers.cookie, SESSION_COOKIE)) this.sessions.delete(id);
  }

  private isValidSession(sessionId: string): boolean {
    // Session ids are 256-bit random values, so lookup timing reveals nothing useful.
    const expires = this.sessions.get(sessionId);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  private prune(t: number): void {
    for (const [id, expires] of this.sessions) if (expires <= t) this.sessions.delete(id);
  }
}

export function sessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/__tokenfault; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/__tokenfault; HttpOnly; SameSite=Strict; Max-Age=0`;
}

const MAX_COOKIE_VALUES = 8;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{1,128}$/;

/** Minimal RFC 6265 cookie lookup (first match wins). */
export function readCookie(header: string | undefined, name: string): string | null {
  return readCookies(header, name)[0] ?? null;
}

/** All well-formed values of a cookie name, in header order (at most 8). */
export function readCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (COOKIE_VALUE.test(value)) values.push(value);
    if (values.length >= MAX_COOKIE_VALUES) break;
  }
  return values;
}
