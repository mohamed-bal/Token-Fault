import { afterEach, describe, expect, it, vi } from 'vitest';
import { intOption, numberOption } from '../src/args.js';
import { main } from '../src/cli.js';
import { UsageError } from '../src/errors.js';
import { formatBytes, formatMs, sanitizeForTerminal } from '../src/output.js';

describe('sanitizeForTerminal', () => {
  it('neutralises terminal escape sequences and control characters from untrusted streams', () => {
    const hostile = 'ok\u001b[2J\u001b]0;pwned\u0007\r\nnext\u009b';
    const safe = sanitizeForTerminal(hostile, 200);
    const controlChars = [...safe].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code < 0xa0);
    });
    expect(controlChars).toEqual([]);
    expect(safe).toBe('ok\\x1b[2J\\x1b]0;pwned\\x07\\r\\nnext\\x9b');
  });

  it('keeps unicode and truncates', () => {
    expect(sanitizeForTerminal('世界 🚀')).toBe('世界 🚀');
    expect(sanitizeForTerminal('x'.repeat(10), 4)).toBe('xxxx…');
  });
});

describe('option parsing', () => {
  it('validates integers strictly', () => {
    expect(intOption('42', 'port', 0, 65535)).toBe(42);
    expect(intOption(undefined, 'port', 0, 65535)).toBeUndefined();
    expect(() => intOption('4.2', 'port', 0, 65535)).toThrow(UsageError);
    expect(() => intOption('1e3', 'port', 0, 65535)).toThrow(UsageError);
    expect(() => intOption('70000', 'port', 0, 65535)).toThrow(UsageError);
  });
  it('validates numbers', () => {
    expect(numberOption('2.5', 'speed', 0.01, 100)).toBe(2.5);
    expect(() => numberOption('NaN', 'speed', 0.01, 100)).toThrow(UsageError);
    expect(() => numberOption('0', 'speed', 0.01, 100)).toThrow(UsageError);
  });
});

describe('formatting', () => {
  it('formats durations and sizes', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(12.34)).toBe('12.3 ms');
    expect(formatMs(2500)).toBe('2.50 s');
    expect(formatBytes(10)).toBe('10 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
  });
});

describe('main', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns usage errors for unknown flags', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await main(['scenarios', '--nope'])).toBe(2);
    expect(stderr.mock.calls.join('')).toContain('Unknown option');
  });

  it('prints scenarios as JSON', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c));
      return true;
    });
    expect(await main(['scenarios', '--json'])).toBe(0);
    expect(JSON.parse(chunks.join('')).scenarios).toHaveLength(9);
  });
});
