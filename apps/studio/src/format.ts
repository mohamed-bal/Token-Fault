import type { SessionSummary, StreamOutcome } from '@tokenfault/shared';

export function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour12: false });
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export const OUTCOME_LABEL: Record<StreamOutcome, string> = {
  pending: 'streaming',
  completed: 'completed',
  incomplete: 'incomplete',
  'stream-error': 'stream error',
  'http-error': 'HTTP error',
  'non-stream': 'non-stream',
};

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted';

export function outcomeTone(outcome: StreamOutcome): Tone {
  switch (outcome) {
    case 'completed':
    case 'non-stream':
      return 'ok';
    case 'pending':
      return 'info';
    case 'incomplete':
      return 'warn';
    case 'stream-error':
    case 'http-error':
      return 'err';
  }
}

export function isFailure(s: SessionSummary): boolean {
  return s.outcome === 'incomplete' || s.outcome === 'stream-error' || s.outcome === 'http-error';
}

/** Median of the defined values, or null. */
export function median(values: readonly (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}
