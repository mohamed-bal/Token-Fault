/**
 * Catalogue of fault types (for building configuration UIs) and the named
 * scenarios A–I. Scenarios are plain, validated fault profiles with a fixed
 * seed, so selecting one by name is fully reproducible.
 */
import type { FaultTypeDescriptor, ScenarioDescriptor } from '@tokenfault/shared';
import {
  DISCONNECT_MODES,
  FaultProfileSchema,
  MALFORMED_KINDS,
  MOCK_ONLY_FAULTS,
} from './schema.js';
import type { FaultProfile, FaultProfileInput, FaultTargetKind } from './schema.js';

export const FAULT_TYPES: readonly FaultTypeDescriptor[] = [
  {
    type: 'delay-first-byte',
    title: 'Delay first byte',
    description:
      'Holds the response (status line and headers included) before anything is sent to the client.',
    phase: 'pre-response',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'delayMs',
        kind: 'integer',
        min: 0,
        max: 600_000,
        unit: 'ms',
        description: 'Delay before the first byte.',
      },
    ],
  },
  {
    type: 'delay-first-content',
    title: 'Delay first content delta',
    description:
      'Sends headers and non-content events normally, then holds the first event that carries content or tool-call data.',
    phase: 'stream',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'delayMs',
        kind: 'integer',
        min: 0,
        max: 600_000,
        unit: 'ms',
        description: 'Extra delay before the first content delta.',
      },
    ],
  },
  {
    type: 'http-error',
    title: 'HTTP error before streaming',
    description:
      'Answers with an error status and an OpenAI-style error body instead of a stream. Upstream is not contacted.',
    phase: 'pre-response',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'status',
        kind: 'integer',
        min: 400,
        max: 599,
        description: 'HTTP status code (e.g. 429, 503).',
      },
      {
        name: 'retryAfterSeconds',
        kind: 'integer',
        min: 0,
        max: 86_400,
        unit: 'seconds',
        optional: true,
        description: 'Value of the Retry-After header.',
      },
    ],
  },
  {
    type: 'disconnect',
    title: 'Mid-stream disconnect',
    description:
      'Terminates the connection after N events or after a duration. "reset" sends a TCP RST, "destroy" closes the socket without finishing the HTTP response, "end" finishes the HTTP response cleanly (an incomplete stream that looks successful at the transport level).',
    phase: 'stream',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'afterEvents',
        kind: 'integer',
        min: 0,
        max: 1_000_000,
        unit: 'events',
        optional: true,
        description: 'Disconnect before delivering event N+1.',
      },
      {
        name: 'afterMs',
        kind: 'integer',
        min: 0,
        max: 600_000,
        unit: 'ms',
        optional: true,
        description: 'Disconnect this long after headers were sent.',
      },
      {
        name: 'mode',
        kind: 'enum',
        options: DISCONNECT_MODES,
        description: 'How the connection is terminated.',
      },
    ],
  },
  {
    type: 'stall',
    title: 'Stream stall',
    description: 'Pauses delivery after N events for a fixed duration, then resumes.',
    phase: 'stream',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'afterEvents',
        kind: 'integer',
        min: 0,
        max: 1_000_000,
        unit: 'events',
        description: 'Events delivered before the stall.',
      },
      {
        name: 'durationMs',
        kind: 'integer',
        min: 0,
        max: 600_000,
        unit: 'ms',
        description: 'Stall duration.',
      },
    ],
  },
  {
    type: 'jitter',
    title: 'Irregular event timing',
    description:
      'Adds a seeded pseudo-random delay, uniform in [minGapMs, maxGapMs], before every event after the first.',
    phase: 'stream',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'minGapMs',
        kind: 'integer',
        min: 0,
        max: 60_000,
        unit: 'ms',
        description: 'Minimum added gap.',
      },
      {
        name: 'maxGapMs',
        kind: 'integer',
        min: 0,
        max: 60_000,
        unit: 'ms',
        description: 'Maximum added gap.',
      },
    ],
  },
  {
    type: 'fragment',
    title: 'Fragmented SSE',
    description:
      'Re-chunks every frame into seeded pseudo-random pieces of [minChunkBytes, maxChunkBytes] bytes, written separately with a short delay so they arrive as separate network reads. Multi-byte UTF-8 characters are split as well. The delay is kept on average: on platforms with coarse timers (Windows, about 15.6 ms) individual gaps can be shorter so the stream does not slow down.',
    phase: 'stream',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'minChunkBytes',
        kind: 'integer',
        min: 1,
        max: 65_536,
        unit: 'bytes',
        description: 'Smallest piece.',
      },
      {
        name: 'maxChunkBytes',
        kind: 'integer',
        min: 1,
        max: 65_536,
        unit: 'bytes',
        description: 'Largest piece.',
      },
      {
        name: 'interChunkDelayMs',
        kind: 'integer',
        min: 0,
        max: 1_000,
        unit: 'ms',
        description: 'Delay between pieces (0 lets TCP coalesce them).',
      },
    ],
  },
  {
    type: 'malformed',
    title: 'Malformed streaming data',
    description:
      'Deliberately injects one malformed frame after N events. This is intentionally invalid output used to test client robustness.',
    phase: 'stream',
    appliesTo: ['proxy', 'mock'],
    params: [
      {
        name: 'afterEvents',
        kind: 'integer',
        min: 0,
        max: 1_000_000,
        unit: 'events',
        description: 'Events delivered before the injection.',
      },
      {
        name: 'kind',
        kind: 'enum',
        options: MALFORMED_KINDS,
        description: 'Type of malformation.',
      },
    ],
  },
  {
    type: 'fragment-tool-calls',
    title: 'Fragmented tool calls',
    description:
      'Mock only: emits a tool call whose JSON arguments are split into fragments of chunkChars characters.',
    phase: 'stream',
    appliesTo: ['mock'],
    params: [
      {
        name: 'chunkChars',
        kind: 'integer',
        min: 1,
        max: 1_000,
        unit: 'chars',
        description: 'Characters per arguments fragment.',
      },
    ],
  },
];

interface ScenarioSource {
  readonly id: string;
  readonly letter: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly profile: FaultProfileInput;
}

const SOURCES: readonly ScenarioSource[] = [
  {
    id: 'slow-first-response',
    letter: 'A',
    title: 'Slow first response',
    description: 'Delays the first byte by 2 s and the first content delta by a further 1.5 s.',
    expectedBehavior:
      'Time-to-first-byte ≥ 2000 ms. Time-to-first-content ≥ 3500 ms. The stream then completes normally with [DONE]. Clients with a short first-byte timeout fail.',
    profile: {
      seed: 1,
      faults: [
        { type: 'delay-first-byte', delayMs: 2000 },
        { type: 'delay-first-content', delayMs: 1500 },
      ],
    },
  },
  {
    id: 'mid-stream-disconnect',
    letter: 'B',
    title: 'Mid-stream disconnect',
    description: 'Resets the TCP connection after 5 events have been delivered.',
    expectedBehavior:
      'HTTP 200 with exactly 5 events, then a connection reset. No [DONE] and no finish_reason. Outcome: incomplete; the client sees a network error.',
    profile: { seed: 1, faults: [{ type: 'disconnect', afterEvents: 5, mode: 'reset' }] },
  },
  {
    id: 'rate-limit-429',
    letter: 'C',
    title: 'HTTP 429 rate limit',
    description: 'Rejects the request with 429 and Retry-After: 2 before any streaming starts.',
    expectedBehavior:
      'HTTP 429, Retry-After: 2, a JSON error body, no SSE events. Upstream is not contacted.',
    profile: {
      seed: 1,
      faults: [
        {
          type: 'http-error',
          status: 429,
          retryAfterSeconds: 2,
          message: 'Rate limit exceeded (injected by TokenFault).',
        },
      ],
    },
  },
  {
    id: 'server-unavailable-503',
    letter: 'D',
    title: 'HTTP 503 unavailable',
    description: 'Rejects the request with 503 before any streaming starts.',
    expectedBehavior:
      'HTTP 503 with a JSON error body and no SSE events. Upstream is not contacted.',
    profile: {
      seed: 1,
      faults: [
        {
          type: 'http-error',
          status: 503,
          message: 'Service unavailable (injected by TokenFault).',
        },
      ],
    },
  },
  {
    id: 'stream-stall',
    letter: 'E',
    title: 'Stream stall',
    description: 'Stops delivering events for 4 s after the 3rd event, then resumes.',
    expectedBehavior:
      'A single inter-event gap ≥ 4000 ms after event 3. The stream then completes normally. Clients with an idle timeout below 4 s abort.',
    profile: { seed: 1, faults: [{ type: 'stall', afterEvents: 3, durationMs: 4000 }] },
  },
  {
    id: 'irregular-timing',
    letter: 'F',
    title: 'Irregular event timing',
    description: 'Adds seeded random gaps of 0–600 ms before every event.',
    expectedBehavior:
      'Inter-event gaps vary between the natural gap and natural + 600 ms. With seed 42 the sequence is identical on every run.',
    profile: { seed: 42, faults: [{ type: 'jitter', minGapMs: 0, maxGapMs: 600 }] },
  },
  {
    id: 'fragmented-sse',
    letter: 'G',
    title: 'Fragmented SSE',
    description: 'Splits every SSE frame into 1–7 byte network writes.',
    expectedBehavior:
      'Many more network chunks than events. Multi-byte characters and CRLF pairs are split across chunks. A correct parser reports the same events and content as without fragmentation.',
    profile: {
      seed: 7,
      faults: [{ type: 'fragment', minChunkBytes: 1, maxChunkBytes: 7, interChunkDelayMs: 1 }],
    },
  },
  {
    id: 'malformed-data',
    letter: 'H',
    title: 'Malformed streaming data',
    description: 'Deliberately injects a truncated JSON event after 3 events.',
    expectedBehavior:
      'Event 4 carries invalid JSON (a chat-invalid-json diagnostic). The stream then continues and completes. Robust clients skip or report the bad event instead of crashing.',
    profile: { seed: 1, faults: [{ type: 'malformed', afterEvents: 3, kind: 'truncated-json' }] },
  },
  {
    id: 'fragmented-tool-calls',
    letter: 'I',
    title: 'Fragmented tool calls',
    description:
      'Mock only: answers with a tool call whose JSON arguments arrive 3 characters at a time.',
    expectedBehavior:
      'Many tool-call deltas for the same call index. Only the first carries id and name. The concatenated arguments are valid JSON and finish_reason is "tool_calls".',
    profile: { seed: 1, faults: [{ type: 'fragment-tool-calls', chunkChars: 3 }] },
  },
];

export interface Scenario {
  readonly descriptor: ScenarioDescriptor;
  readonly profile: FaultProfile;
}

export const SCENARIOS: readonly Scenario[] = SOURCES.map((source) => {
  const profile = FaultProfileSchema.parse(source.profile);
  const appliesTo: FaultTargetKind[] = profile.faults.some((f) => MOCK_ONLY_FAULTS.has(f.type))
    ? ['mock']
    : ['proxy', 'mock'];
  return {
    profile,
    descriptor: {
      id: source.id,
      letter: source.letter,
      title: source.title,
      description: source.description,
      expectedBehavior: source.expectedBehavior,
      appliesTo,
      faults: profile.faults,
      seed: profile.seed,
    },
  };
});

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.descriptor.id === id);
}
