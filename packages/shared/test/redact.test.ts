import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  captureResponseHeaders,
  describeUrlSafely,
  isSensitiveHeader,
  redactPathQuery,
  redactSecrets,
} from '../src/redact.js';
import { describeError, errorBody } from '../src/errors.js';

describe('isSensitiveHeader', () => {
  it.each([
    'Authorization',
    'proxy-authorization',
    'Cookie',
    'set-cookie',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'OpenAI-Organization',
    'x-amz-security-token',
    'x-session-id',
  ])('flags %s', (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each(['content-type', 'x-request-id', 'retry-after'])('does not flag %s', (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });
});

describe('captureResponseHeaders', () => {
  it('keeps only allowlisted headers and joins multi-values', () => {
    const captured = captureResponseHeaders({
      'Content-Type': 'text/event-stream',
      'set-cookie': ['a=1', 'b=2'],
      'x-request-id': 'req_1',
      'x-ratelimit-remaining-requests': 42,
      server: 'nginx',
      'cache-control': ['no-cache', 'no-store'],
      'retry-after': undefined,
    });
    expect(captured).toEqual({
      'content-type': 'text/event-stream',
      'x-request-id': 'req_1',
      'x-ratelimit-remaining-requests': '42',
      'cache-control': 'no-cache, no-store',
    });
  });
});

describe('redactPathQuery', () => {
  it('redacts every query value but keeps names', () => {
    expect(redactPathQuery('/v1/chat/completions?key=abc&debug&x=1')).toBe(
      `/v1/chat/completions?key=${REDACTED}&debug&x=${REDACTED}`,
    );
  });
  it('leaves paths without a query untouched', () => {
    expect(redactPathQuery('/v1/models')).toBe('/v1/models');
    expect(redactPathQuery('/v1/models?')).toBe('/v1/models');
  });
});

describe('redactSecrets', () => {
  it('scrubs common credential shapes', () => {
    const text =
      'Incorrect API key provided: sk-proj-abcdefghijklmnop. Header was Bearer abc.def-ghi and api_key=supersecret123 AIzaSyA1234567890123456789012345';
    const out = redactSecrets(text);
    expect(out).not.toContain('sk-proj-abcdefghijklmnop');
    expect(out).not.toContain('abc.def-ghi');
    expect(out).not.toContain('supersecret123');
    expect(out).not.toContain('AIzaSyA');
    expect(out).toContain('api_key=' + REDACTED);
  });
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('The task is done.')).toBe('The task is done.');
  });
});

describe('describeUrlSafely', () => {
  it('drops credentials, query and fragment', () => {
    expect(describeUrlSafely(new URL('https://user:pw@api.example.com/v1?key=1#x'))).toBe(
      'https://api.example.com/v1',
    );
    expect(describeUrlSafely(new URL('http://localhost:4010/'))).toBe('http://localhost:4010');
  });
});

describe('errors', () => {
  it('scrubs secrets from error bodies', () => {
    expect(errorBody('tokenfault_internal', 'bad key sk-1234567890abcdef').error.message).toBe(
      `bad key ${REDACTED}`,
    );
  });
  it('describes node-style errors with their code', () => {
    const err = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    expect(describeError(err)).toBe('ECONNREFUSED: connect refused');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(42)).toBe('Unknown error');
  });
});
