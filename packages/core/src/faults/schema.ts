/**
 * Fault specifications: the canonical, validated configuration format of the
 * fault engine. Every fault is a strict object (unknown keys are rejected)
 * with bounded numeric fields, so configuration from the Studio, the CLI or
 * request headers cannot request unbounded delays or allocations.
 */
import { z } from 'zod';

const MAX_DELAY_MS = 10 * 60 * 1000;
const delayMs = z.number().int().min(0).max(MAX_DELAY_MS);
const eventCount = z.number().int().min(0).max(1_000_000);

export const DISCONNECT_MODES = ['reset', 'destroy', 'end'] as const;
export const MALFORMED_KINDS = [
  'truncated-json',
  'invalid-utf8',
  'missing-blank-line',
  'unknown-field',
  'html-error-page',
] as const;

export const DelayFirstByteSchema = z.strictObject({
  type: z.literal('delay-first-byte'),
  delayMs,
});

export const DelayFirstContentSchema = z.strictObject({
  type: z.literal('delay-first-content'),
  delayMs,
});

export const HttpErrorSchema = z.strictObject({
  type: z.literal('http-error'),
  status: z.number().int().min(400).max(599),
  retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
  message: z.string().min(1).max(500).optional(),
});

export const DisconnectSchema = z
  .strictObject({
    type: z.literal('disconnect'),
    afterEvents: eventCount.optional(),
    afterMs: delayMs.optional(),
    mode: z.enum(DISCONNECT_MODES).default('reset'),
  })
  .refine((f) => (f.afterEvents === undefined) !== (f.afterMs === undefined), {
    message: 'disconnect requires exactly one of afterEvents or afterMs',
  });

export const StallSchema = z.strictObject({
  type: z.literal('stall'),
  afterEvents: eventCount,
  durationMs: delayMs,
});

export const JitterSchema = z
  .strictObject({
    type: z.literal('jitter'),
    minGapMs: z.number().int().min(0).max(60_000),
    maxGapMs: z.number().int().min(0).max(60_000),
  })
  .refine((f) => f.minGapMs <= f.maxGapMs, { message: 'minGapMs must be <= maxGapMs' });

export const FragmentSchema = z
  .strictObject({
    type: z.literal('fragment'),
    minChunkBytes: z.number().int().min(1).max(65_536),
    maxChunkBytes: z.number().int().min(1).max(65_536),
    interChunkDelayMs: z.number().int().min(0).max(1_000).default(2),
  })
  .refine((f) => f.minChunkBytes <= f.maxChunkBytes, {
    message: 'minChunkBytes must be <= maxChunkBytes',
  });

export const MalformedSchema = z.strictObject({
  type: z.literal('malformed'),
  afterEvents: eventCount,
  kind: z.enum(MALFORMED_KINDS),
});

/** Mock-only: emit tool-call arguments in fragments of `chunkChars` characters. */
export const FragmentToolCallsSchema = z.strictObject({
  type: z.literal('fragment-tool-calls'),
  chunkChars: z.number().int().min(1).max(1_000),
});

export const FaultSpecSchema = z.discriminatedUnion('type', [
  DelayFirstByteSchema,
  DelayFirstContentSchema,
  HttpErrorSchema,
  DisconnectSchema,
  StallSchema,
  JitterSchema,
  FragmentSchema,
  MalformedSchema,
  FragmentToolCallsSchema,
]);

export type FaultSpec = z.infer<typeof FaultSpecSchema>;
export type FaultSpecInput = z.input<typeof FaultSpecSchema>;
export type FaultType = FaultSpec['type'];
export type DisconnectMode = (typeof DISCONNECT_MODES)[number];
export type MalformedKind = (typeof MALFORMED_KINDS)[number];

/** Fault types that only the mock server can honour (they shape generated content). */
export const MOCK_ONLY_FAULTS: ReadonlySet<FaultType> = new Set(['fragment-tool-calls']);

export const FaultProfileSchema = z
  .strictObject({
    faults: z.array(FaultSpecSchema).max(16),
    seed: z.number().int().min(0).max(0xffffffff).default(1),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    profile.faults.forEach((fault, i) => {
      if (seen.has(fault.type)) {
        ctx.addIssue({
          code: 'custom',
          path: ['faults', i, 'type'],
          message: `duplicate fault type "${fault.type}"`,
        });
      }
      seen.add(fault.type);
    });
  });

export type FaultProfile = z.infer<typeof FaultProfileSchema>;
export type FaultProfileInput = z.input<typeof FaultProfileSchema>;

export type FaultTargetKind = 'proxy' | 'mock';

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Validates an untrusted fault profile for a given target. Returns a
 * human-readable error message instead of throwing.
 */
export function parseFaultProfile(
  input: unknown,
  target: FaultTargetKind,
): ParseResult<FaultProfile> {
  const result = FaultProfileSchema.safeParse(input);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
  if (target === 'proxy') {
    const mockOnly = result.data.faults.filter((f) => MOCK_ONLY_FAULTS.has(f.type));
    if (mockOnly.length > 0) {
      return {
        ok: false,
        error: `fault type(s) ${mockOnly.map((f) => `"${f.type}"`).join(', ')} can only be applied by the mock server`,
      };
    }
  }
  return { ok: true, value: result.data };
}
