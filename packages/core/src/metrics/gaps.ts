import type { GapStats } from '@tokenfault/shared';

/** Maximum number of gaps retained for percentile computation. */
export const MAX_TRACKED_GAPS = 1_000_000;

/**
 * Computes exact statistics over inter-event gaps. Percentiles use the
 * nearest-rank method on the sorted sample. No interpolation or estimation.
 */
export function computeGapStats(gaps: readonly number[]): GapStats | null {
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  let sum = 0;
  for (const g of sorted) sum += g;
  return {
    count: sorted.length,
    minMs: round(sorted[0]!),
    maxMs: round(sorted[sorted.length - 1]!),
    meanMs: round(sum / sorted.length),
    p50Ms: round(nearestRank(sorted, 0.5)),
    p95Ms: round(nearestRank(sorted, 0.95)),
    p99Ms: round(nearestRank(sorted, 0.99)),
  };
}

function nearestRank(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

/** Rounds to microsecond precision so serialised values stay readable without hiding real differences. */
export function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
