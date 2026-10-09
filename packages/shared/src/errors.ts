import { redactSecrets } from './redact.js';
import type { ErrorBody, TokenFaultErrorCode } from './types.js';

/** Builds a JSON error body. The message is always secret-scrubbed. */
export function errorBody(code: TokenFaultErrorCode, message: string): ErrorBody {
  return { error: { type: 'tokenfault_error', code, message: redactSecrets(message) } };
}

/** Extracts a human-readable message from an unknown thrown value without leaking stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeLikeError).code;
    const base =
      typeof code === 'string' && !error.message.includes(code)
        ? `${code}: ${error.message}`
        : error.message;
    return redactSecrets(base);
  }
  if (typeof error === 'string') return redactSecrets(error);
  return 'Unknown error';
}

interface NodeLikeError extends Error {
  code?: unknown;
}
