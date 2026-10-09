import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { UsageError } from './errors.js';

type Options = NonNullable<ParseArgsConfig['options']>;

/** Strict `parseArgs` wrapper that converts parse failures into usage errors. */
export function parse<T extends Options>(
  argv: readonly string[],
  options: T,
  allowPositionals = false,
) {
  try {
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function intOption(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new UsageError(`--${name} must be an integer, got "${value}"`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}

export function numberOption(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new UsageError(`--${name} must be a number between ${min} and ${max}`);
  return n;
}
