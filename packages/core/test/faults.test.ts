import { describe, expect, it } from 'vitest';
import { FAULT_TYPES, SCENARIOS, findScenario } from '../src/faults/catalog.js';
import { FaultPlanner, malformedFrame } from '../src/faults/planner.js';
import type { FaultAction } from '../src/faults/planner.js';
import { FaultProfileSchema, parseFaultProfile } from '../src/faults/schema.js';
import type { FaultProfileInput } from '../src/faults/schema.js';
import { FrameClassifier } from '../src/faults/classify.js';
import { WaitPacer, executeFaultActions, sleep } from '../src/faults/executor.js';
import type { FaultSink } from '../src/faults/executor.js';
import { SseDecoder } from '../src/sse/decoder.js';
import { interpretChatEventData } from '../src/openai/chat-stream.js';

const enc = new TextEncoder();

const contentFrame = (text: string) =>
  enc.encode(
    `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
  );
const roleFrame = enc.encode(
  'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
);
const commentFrame = enc.encode(': keep-alive\n\n');

function planner(input: FaultProfileInput): FaultPlanner {
  return new FaultPlanner(FaultProfileSchema.parse(input));
}

function runFrames(p: FaultPlanner, frames: Uint8Array[]): FaultAction[] {
  const classifier = new FrameClassifier();
  const actions = frames.flatMap((f) => p.planFrame(classifier.classify(f)));
  return [...actions, ...p.planEnd()];
}

const kinds = (actions: FaultAction[]) => actions.map((a) => a.kind);

describe('fault schema validation', () => {
  it('accepts every scenario in the catalogue', () => {
    expect(SCENARIOS.map((s) => s.descriptor.letter)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
    ]);
    for (const s of SCENARIOS)
      expect(
        FaultProfileSchema.safeParse({ faults: s.profile.faults, seed: s.profile.seed }).success,
      ).toBe(true);
  });

  it('describes every fault type', () => {
    const typesInSchema = [
      'delay-first-byte',
      'delay-first-content',
      'http-error',
      'disconnect',
      'stall',
      'jitter',
      'fragment',
      'malformed',
      'fragment-tool-calls',
    ];
    expect(FAULT_TYPES.map((f) => f.type)).toEqual(typesInSchema);
  });

  it.each([
    [{ faults: [{ type: 'delay-first-byte', delayMs: -1 }] }, /delayMs/],
    [{ faults: [{ type: 'delay-first-byte', delayMs: 10 * 60 * 1000 + 1 }] }, /delayMs/],
    [{ faults: [{ type: 'delay-first-byte', delayMs: 1.5 }] }, /delayMs/],
    [{ faults: [{ type: 'http-error', status: 200 }] }, /status/],
    [{ faults: [{ type: 'disconnect' }] }, /exactly one/],
    [{ faults: [{ type: 'disconnect', afterEvents: 1, afterMs: 1 }] }, /exactly one/],
    [{ faults: [{ type: 'jitter', minGapMs: 10, maxGapMs: 5 }] }, /minGapMs/],
    [{ faults: [{ type: 'fragment', minChunkBytes: 0, maxChunkBytes: 5 }] }, /minChunkBytes/],
    [{ faults: [{ type: 'malformed', afterEvents: 1, kind: 'nope' }] }, /kind/],
    [{ faults: [{ type: 'teleport' }] }, /type/],
    [{ faults: [{ type: 'stall', afterEvents: 1, durationMs: 1, extra: true }] }, /extra/],
    [
      {
        faults: [
          { type: 'stall', afterEvents: 1, durationMs: 1 },
          { type: 'stall', afterEvents: 2, durationMs: 1 },
        ],
      },
      /duplicate/,
    ],
    [{ faults: [], seed: -1 }, /seed/],
    [{ faults: [], nope: 1 }, /nope/],
  ])('rejects invalid profile %#', (input, message) => {
    const result = parseFaultProfile(input, 'mock');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it('rejects mock-only faults for the proxy', () => {
    const result = parseFaultProfile(
      { faults: [{ type: 'fragment-tool-calls', chunkChars: 2 }] },
      'proxy',
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/mock server/) });
    expect(
      parseFaultProfile({ faults: [{ type: 'fragment-tool-calls', chunkChars: 2 }] }, 'mock').ok,
    ).toBe(true);
  });

  it('applies defaults', () => {
    const result = parseFaultProfile({ faults: [{ type: 'disconnect', afterEvents: 2 }] }, 'proxy');
    expect(result).toEqual({
      ok: true,
      value: { seed: 1, faults: [{ type: 'disconnect', afterEvents: 2, mode: 'reset' }] },
    });
  });

  it('finds scenarios by id', () => {
    expect(findScenario('rate-limit-429')?.descriptor.letter).toBe('C');
    expect(findScenario('nope')).toBeUndefined();
    expect(findScenario('fragmented-tool-calls')?.descriptor.appliesTo).toEqual(['mock']);
  });
});

describe('FaultPlanner', () => {
  it('passes frames through untouched with an empty profile', () => {
    const p = planner({ faults: [] });
    expect(p.needsFraming).toBe(false);
    expect(p.preResponse()).toEqual({ delayMs: 0, error: null });
    const actions = runFrames(p, [roleFrame, contentFrame('a')]);
    expect(actions).toEqual([
      { kind: 'write', bytes: roleFrame, injected: false },
      { kind: 'write', bytes: contentFrame('a'), injected: false },
    ]);
  });

  it('plans pre-response faults (scenarios A, C, D)', () => {
    expect(new FaultPlanner(findScenario('slow-first-response')!.profile).preResponse()).toEqual({
      delayMs: 2000,
      error: null,
    });
    expect(
      new FaultPlanner(findScenario('rate-limit-429')!.profile).preResponse().error,
    ).toMatchObject({ status: 429, retryAfterSeconds: 2 });
    expect(
      new FaultPlanner(findScenario('server-unavailable-503')!.profile).preResponse().error,
    ).toMatchObject({ status: 503 });
  });

  it('delays only the first content delta (scenario A)', () => {
    const p = new FaultPlanner(findScenario('slow-first-response')!.profile);
    const actions = runFrames(p, [roleFrame, contentFrame('a'), contentFrame('b')]);
    expect(kinds(actions)).toEqual(['write', 'annotate', 'wait', 'write', 'write']);
    expect(actions[2]).toEqual({ kind: 'wait', ms: 1500, faultType: 'delay-first-content' });
  });

  it('disconnects before event N+1 and stops planning (scenario B)', () => {
    const p = planner({ faults: [{ type: 'disconnect', afterEvents: 2, mode: 'destroy' }] });
    const actions = runFrames(p, [
      roleFrame,
      commentFrame,
      contentFrame('a'),
      contentFrame('b'),
      contentFrame('c'),
    ]);
    expect(kinds(actions)).toEqual(['write', 'write', 'write', 'annotate', 'disconnect']);
    expect(actions.at(-1)).toEqual({
      kind: 'disconnect',
      mode: 'destroy',
      faultType: 'disconnect',
    });
    expect(p.isDisconnected).toBe(true);
  });

  it('disconnects before the first event with afterEvents=0', () => {
    const p = planner({ faults: [{ type: 'disconnect', afterEvents: 0 }] });
    expect(kinds(runFrames(p, [roleFrame]))).toEqual(['annotate', 'disconnect']);
  });

  it('exposes time-based disconnects', () => {
    expect(
      planner({ faults: [{ type: 'disconnect', afterMs: 250, mode: 'end' }] }).timedDisconnect(),
    ).toEqual({ afterMs: 250, mode: 'end' });
    expect(planner({ faults: [{ type: 'disconnect', afterMs: 250 }] }).needsFraming).toBe(false);
  });

  it('stalls once after N events (scenario E)', () => {
    const p = planner({ faults: [{ type: 'stall', afterEvents: 1, durationMs: 4000 }] });
    const actions = runFrames(p, [roleFrame, contentFrame('a'), contentFrame('b')]);
    expect(kinds(actions)).toEqual(['write', 'annotate', 'wait', 'write', 'write']);
  });

  it('produces identical jitter for identical seeds and different jitter for different seeds (scenario F)', () => {
    const frames = Array.from({ length: 20 }, (_, i) => contentFrame(String(i)));
    const waits = (seed: number) =>
      runFrames(planner({ seed, faults: [{ type: 'jitter', minGapMs: 0, maxGapMs: 600 }] }), frames)
        .filter((a) => a.kind === 'wait')
        .map((a) => (a.kind === 'wait' ? a.ms : -1));
    expect(waits(42)).toEqual(waits(42));
    expect(waits(42)).not.toEqual(waits(43));
    for (const ms of waits(42)) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(600);
    }
  });

  it('fragments frames into bounded pieces that concatenate to the original (scenario G)', () => {
    const p = planner({
      seed: 7,
      faults: [{ type: 'fragment', minChunkBytes: 1, maxChunkBytes: 7, interChunkDelayMs: 0 }],
    });
    const frame = contentFrame('héllo 世界 🚀');
    const writes = runFrames(p, [frame]).flatMap((a) => (a.kind === 'write' ? [a.bytes] : []));
    expect(writes.length).toBeGreaterThan(frame.length / 7);
    for (const w of writes) expect(w.length).toBeLessThanOrEqual(7);
    expect(new Uint8Array(writes.flatMap((w) => [...w]))).toEqual(frame);
  });

  it('inserts waits between fragments when interChunkDelayMs > 0', () => {
    const p = planner({
      faults: [{ type: 'fragment', minChunkBytes: 4, maxChunkBytes: 4, interChunkDelayMs: 3 }],
    });
    const actions = runFrames(p, [enc.encode('data: abcd\n\n')]);
    expect(kinds(actions)).toEqual(['annotate', 'write', 'wait', 'write', 'wait', 'write']);
  });

  it('injects a malformed frame before event N+1 (scenario H)', () => {
    const p = new FaultPlanner(findScenario('malformed-data')!.profile);
    const frames = [roleFrame, contentFrame('a'), contentFrame('b'), contentFrame('c')];
    const actions = runFrames(p, frames);
    const injected = actions.filter((a) => a.kind === 'write' && a.injected);
    expect(injected).toHaveLength(1);
    expect(actions.findIndex((a) => a.kind === 'write' && a.injected)).toBe(4);
  });

  it('injects the malformed frame at the end if the stream is shorter than afterEvents', () => {
    const p = planner({
      faults: [{ type: 'malformed', afterEvents: 10, kind: 'html-error-page' }],
    });
    const actions = runFrames(p, [roleFrame]);
    expect(kinds(actions)).toEqual(['write', 'annotate', 'write']);
  });

  it('annotates faults that never triggered', () => {
    const p = planner({
      faults: [
        { type: 'stall', afterEvents: 5, durationMs: 1 },
        { type: 'disconnect', afterEvents: 5 },
      ],
    });
    const actions = runFrames(p, [roleFrame]);
    expect(
      actions
        .filter((a) => a.kind === 'annotate')
        .map((a) => (a.kind === 'annotate' ? a.faultType : '')),
    ).toEqual(['stall', 'disconnect']);
  });

  it('is deterministic for a full composite profile', () => {
    const profile: FaultProfileInput = {
      seed: 99,
      faults: [
        { type: 'jitter', minGapMs: 1, maxGapMs: 50 },
        { type: 'fragment', minChunkBytes: 2, maxChunkBytes: 9 },
        { type: 'stall', afterEvents: 2, durationMs: 10 },
        { type: 'malformed', afterEvents: 3, kind: 'invalid-utf8' },
      ],
    };
    const frames = Array.from({ length: 8 }, (_, i) => contentFrame(`token-${i}`));
    expect(runFrames(planner(profile), frames)).toEqual(runFrames(planner(profile), frames));
  });
});

describe('malformed frames decode into the documented diagnostics', () => {
  const decodeWith = (bytes: Uint8Array, next = contentFrame('next')) => {
    const d = new SseDecoder();
    return [...d.push(bytes), ...d.push(next), ...d.end()];
  };

  it('truncated-json', () => {
    const items = decodeWith(malformedFrame('truncated-json'));
    const first = items.find((i) => i.kind === 'event');
    expect(first?.kind === 'event' && interpretChatEventData(first.event.data).kind).toBe(
      'invalid-json',
    );
  });
  it('invalid-utf8', () => {
    expect(
      decodeWith(malformedFrame('invalid-utf8')).some(
        (i) => i.kind === 'diagnostic' && i.diagnostic.code === 'sse-invalid-utf8',
      ),
    ).toBe(true);
  });
  it('missing-blank-line merges with the next event', () => {
    const events = decodeWith(malformedFrame('missing-blank-line')).filter(
      (i) => i.kind === 'event',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind === 'event' && interpretChatEventData(events[0].event.data).kind).toBe(
      'invalid-json',
    );
  });
  it.each(['unknown-field', 'html-error-page'] as const)('%s', (kind) => {
    expect(
      decodeWith(malformedFrame(kind)).some(
        (i) => i.kind === 'diagnostic' && i.diagnostic.code === 'sse-unknown-field',
      ),
    ).toBe(true);
  });
});

describe('executor', () => {
  function recordingSink() {
    const log: string[] = [];
    const sink: FaultSink = {
      write: (bytes, injected) => {
        log.push(`write:${bytes.length}:${injected}`);
        return Promise.resolve();
      },
      disconnect: (mode) => void log.push(`disconnect:${mode}`),
      annotate: (type) => void log.push(`annotate:${type}`),
    };
    return { log, sink };
  }

  it('executes actions in order and stops at disconnect', async () => {
    const { log, sink } = recordingSink();
    const result = await executeFaultActions(
      [
        { kind: 'write', bytes: new Uint8Array(3), injected: false },
        { kind: 'wait', ms: 1, faultType: 'stall' },
        { kind: 'annotate', faultType: 'disconnect', message: 'x' },
        { kind: 'disconnect', mode: 'reset', faultType: 'disconnect' },
        { kind: 'write', bytes: new Uint8Array(1), injected: false },
      ],
      sink,
      new AbortController().signal,
    );
    expect(result).toBe('disconnected');
    expect(log).toEqual(['write:3:false', 'annotate:disconnect', 'disconnect:reset']);
  });

  it('aborts a long wait promptly', async () => {
    const { sink } = recordingSink();
    const controller = new AbortController();
    const started = performance.now();
    const pending = executeFaultActions(
      [{ kind: 'wait', ms: 60_000, faultType: 'stall' }],
      sink,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toBe('aborted');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('sleep resolves false when already aborted and true otherwise', async () => {
    const c = new AbortController();
    c.abort();
    expect(await sleep(10, c.signal)).toBe(false);
    expect(await sleep(0)).toBe(true);
    expect(await sleep(1)).toBe(true);
  });
});

describe('WaitPacer (coarse timers)', () => {
  /** Simulates a platform where every timer fires 15.6 ms late (Windows' default resolution). */
  function coarseClock() {
    let t = 0;
    let calls = 0;
    return {
      sleeps: () => calls / 2,
      elapsed: () => t,
      clock: () => {
        // Called once before and once after each real sleep.
        if (calls++ % 2 === 1) t += 15.6;
        return t;
      },
    };
  }

  it('keeps a run of 1 ms waits on schedule instead of paying the timer granularity each time', async () => {
    const c = coarseClock();
    const pacer = new WaitPacer(c.clock);
    for (let i = 0; i < 200; i++) expect(await pacer.wait(1)).toBe(true);
    // Without compensation: 200 sleeps × 15.6 ms ≈ 3.1 s for 200 ms of configured delay.
    expect(c.sleeps()).toBeLessThanOrEqual(Math.ceil(200 / 15.6) + 1);
    expect(c.elapsed()).toBeGreaterThanOrEqual(180);
    expect(c.elapsed()).toBeLessThanOrEqual(220);
  });

  it('still sleeps for long waits and carries at most 50 ms of overshoot', async () => {
    let t = 0;
    let n = 0;
    // One huge overshoot (e.g. a GC pause) must not swallow a later deliberate stall.
    const pacer = new WaitPacer(() => (n++ === 1 ? (t += 500) : t));
    await pacer.wait(1);
    const before = n;
    await pacer.wait(60);
    expect(n).toBe(before + 2); // slept for the 10 ms not covered by the 50 ms cap
  });

  it('stops when aborted, including during a paid-off wait', async () => {
    const controller = new AbortController();
    const c = coarseClock();
    const pacer = new WaitPacer(c.clock);
    await pacer.wait(1, controller.signal);
    controller.abort();
    expect(await pacer.wait(1, controller.signal)).toBe(false);
  });

  it('keeps writes separated by an event-loop turn when a wait is paid off', async () => {
    const c = coarseClock();
    const pacer = new WaitPacer(c.clock);
    const order: string[] = [];
    await pacer.wait(1); // creates ~14.6 ms of credit
    setImmediate(() => order.push('io-turn'));
    await pacer.wait(1); // paid off: must still yield
    order.push('after-wait');
    expect(order).toEqual(['io-turn', 'after-wait']);
  });
});

describe('executeFaultActions: per-gap minimums', () => {
  const noopSink: FaultSink = {
    write: () => Promise.resolve(),
    disconnect: () => undefined,
    annotate: () => undefined,
  };

  it('never shortens a jitter or stall wait with overshoot carried from fragmentation gaps', async () => {
    // A clock on which every sleep "took" 15.6 ms creates ~14.6 ms of credit after one 1 ms gap.
    let t = 0;
    let calls = 0;
    const pacer = new WaitPacer(() => (calls++ % 2 === 1 ? (t += 15.6) : t));
    const controller = new AbortController();
    const started = performance.now();
    await executeFaultActions(
      [
        { kind: 'wait', ms: 1, faultType: 'fragment' },
        { kind: 'wait', ms: 20, faultType: 'jitter' },
      ],
      noopSink,
      controller.signal,
      pacer,
    );
    // The jitter gap is slept in full (minus timer rounding), not reduced to ~5 ms.
    expect(performance.now() - started).toBeGreaterThanOrEqual(19);
  });
});
