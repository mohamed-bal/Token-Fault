import { describe, expect, it } from 'vitest';
import { REDACTED } from '@tokenfault/shared';
import { StreamInspector } from '../src/inspector/stream-inspector.js';
import { sessionDetail } from '../src/inspector/session.js';
import type { SessionMeta } from '../src/inspector/session.js';
import {
  createRecording,
  parseRecording,
  redactEventData,
  serializeRecording,
  validateRecording,
} from '../src/recording/recording.js';
import { createReplayPlan } from '../src/replay/plan.js';
import { runReplay } from '../src/replay/run.js';
import type { ReplaySink } from '../src/replay/run.js';
import { SseDecoder } from '../src/sse/decoder.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const META: SessionMeta = {
  id: 'sess-1',
  source: 'proxy',
  startedAt: '2026-10-09T10:00:00.000Z',
  method: 'POST',
  path: '/v1/chat/completions',
  scenarioId: null,
  faults: [],
  request: { model: 'mock-1', stream: true, messageCount: 1, toolCount: 0, bodyBytes: 80 },
  replayOf: null,
};

const chunkData = (content: string, finish: string | null = null) =>
  JSON.stringify({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'mock-1',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });

function capturedSession(capturePayloads = true) {
  const insp = new StreamInspector({ capturePayloads });
  insp.onHeaders(
    200,
    { 'content-type': 'text/event-stream', 'x-request-id': 'r1', authorization: 'Bearer sk-x' },
    5,
  );
  insp.onChunk(enc.encode(`data: ${chunkData('secret ')}\n\ndata: ${chunkData('content')}`), 10);
  insp.onChunk(enc.encode(`\n\ndata: ${chunkData('', 'stop')}\n\ndata: [DONE]\n\n`), 40);
  insp.onEnd({ kind: 'eof', atMs: 45, detail: null });
  return sessionDetail(META, insp, [
    { atMs: 7, faultType: 'stall', message: 'test', afterEvents: 0 },
  ]);
}

const FIXED_NOW = () => new Date('2026-10-09T12:00:00.000Z');

describe('redactEventData', () => {
  it('keeps structure and structural strings, redacts free text', () => {
    const out = JSON.parse(
      redactEventData(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'secret',
                tool_calls: [
                  {
                    index: 0,
                    id: 't',
                    type: 'function',
                    function: { name: 'get', arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: 'stop',
            },
          ],
          usage: { total_tokens: 3 },
        }),
      ),
    );
    expect(out).toEqual({
      id: 'c1',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: REDACTED,
            tool_calls: [
              {
                index: 0,
                id: 't',
                type: 'function',
                function: { name: 'get', arguments: REDACTED },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { total_tokens: 3 },
    });
  });

  it('keeps [DONE] and replaces non-JSON data', () => {
    expect(redactEventData('[DONE]')).toBe('[DONE]');
    expect(redactEventData('plain secret text')).toBe(REDACTED);
  });
});

describe('createRecording', () => {
  it('excludes payloads by default', () => {
    const rec = createRecording(capturedSession(), {
      toolVersion: '0.1.0',
      seed: null,
      now: FIXED_NOW,
    });
    expect(rec.payloads.included).toBe(false);
    expect(rec.chunks).toEqual([]);
    const text = serializeRecording(rec);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('sk-x');
    expect(rec.session.responseHeaders).toEqual({
      'content-type': 'text/event-stream',
      'x-request-id': 'r1',
    });
    expect(rec.events.map((e) => e.kind)).toEqual(['chunk', 'chunk', 'chunk', 'done']);
    expect(rec.recordedAt).toBe('2026-10-09T12:00:00.000Z');
  });

  it('includes payloads and chunks only when requested', () => {
    const rec = createRecording(capturedSession(), {
      toolVersion: '0.1.0',
      seed: 5,
      includePayloads: true,
      now: FIXED_NOW,
    });
    expect(rec.payloads.included).toBe(true);
    expect(rec.chunks).toHaveLength(2);
    expect(serializeRecording(rec)).toContain('secret');
    expect(rec.session.seed).toBe(5);
  });

  it('cannot include payloads that were never captured', () => {
    const rec = createRecording(capturedSession(false), {
      toolVersion: '0.1.0',
      seed: null,
      includePayloads: true,
    });
    expect(rec.payloads.included).toBe(false);
    expect(serializeRecording(rec)).not.toContain('secret');
    // Skeletons are rebuilt from the interpretation, so structure survives.
    const finish = JSON.parse(rec.events[2]!.data);
    expect(finish.choices[0].finish_reason).toBe('stop');
  });
});

describe('parseRecording', () => {
  const good = serializeRecording(
    createRecording(capturedSession(), { toolVersion: '0.1.0', seed: null, includePayloads: true }),
  );

  it('round-trips', () => {
    const result = parseRecording(good, 1_000_000);
    expect(result.ok).toBe(true);
  });

  it('rejects oversized input before parsing', () => {
    expect(parseRecording(good, 100)).toEqual({
      ok: false,
      error: expect.stringMatching(/limit is 100 bytes/),
    });
  });

  it('rejects invalid JSON, wrong versions, unknown keys and bad values', () => {
    const base = JSON.parse(good);
    expect(parseRecording('{', 1e6).ok).toBe(false);
    expect(validateRecording({ ...base, schemaVersion: 2 })).toEqual({
      ok: false,
      error: expect.stringMatching(/schemaVersion 2/),
    });
    expect(validateRecording({ ...base, evil: true }).ok).toBe(false);
    expect(
      validateRecording({ ...base, session: { ...base.session, id: '../../etc/passwd' } }).ok,
    ).toBe(false);
    expect(
      validateRecording({ ...base, session: { ...base.session, method: 'post; rm' } }).ok,
    ).toBe(false);
    expect(
      validateRecording({
        ...base,
        chunks: [{ seq: 0, atMs: -1, byteLength: 1, dataBase64: 'AA==' }],
      }).ok,
    ).toBe(false);
  });

  it('rejects non-monotonic timelines', () => {
    const base = JSON.parse(good);
    const events = [...base.events];
    events[1] = { ...events[1], atMs: 0 };
    expect(validateRecording({ ...base, events })).toEqual({
      ok: false,
      error: expect.stringMatching(/non-decreasing/),
    });
  });

  it('rejects chunks in payload-free recordings', () => {
    const base = JSON.parse(good);
    expect(validateRecording({ ...base, payloads: { included: false } }).ok).toBe(false);
  });

  it('is not affected by __proto__ keys', () => {
    const withProto = good.replace('"format"', '"__proto__": {"polluted": true}, "format"');
    expect(parseRecording(withProto, 1e6).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

function memorySink() {
  const log: { t: number; kind: string; value: string }[] = [];
  let t = 0;
  const bytes: Uint8Array[] = [];
  const sink: ReplaySink = {
    start: (status, headers) =>
      void log.push({ t, kind: 'start', value: `${status} ${headers['content-type']}` }),
    write: (b) => {
      bytes.push(b);
      log.push({ t, kind: 'write', value: String(b.length) });
      return Promise.resolve();
    },
    finish: (mode) => void log.push({ t, kind: 'finish', value: mode }),
  };
  return { log, sink, bytes, setTime: (v: number) => (t = v) };
}

describe('replay', () => {
  it('replays chunks byte-exactly with original timing', async () => {
    const rec = createRecording(capturedSession(), {
      toolVersion: '0',
      seed: null,
      includePayloads: true,
    });
    const plan = createReplayPlan(rec);
    expect(plan.mode).toBe('chunks');
    expect(plan.steps.map((s) => s.atMs)).toEqual([10, 40]);
    expect(plan.headersAtMs).toBe(5);
    expect(plan.ending).toEqual({ atMs: 45, mode: 'end' });
    const { sink, bytes } = memorySink();
    expect(await runReplay(plan, sink, new AbortController().signal)).toBe('completed');
    const original = capturedSession().chunks.map((c) => c.dataBase64);
    expect(bytes.map((b) => Buffer.from(b).toString('base64'))).toEqual(original);
  });

  it('replays payload-free recordings as events that decode to the same structure', () => {
    const rec = createRecording(capturedSession(), { toolVersion: '0', seed: null });
    const plan = createReplayPlan(rec, { kind: 'scaled', factor: 2 });
    expect(plan.mode).toBe('events');
    expect(plan.steps.map((s) => s.atMs)).toEqual([5, 20, 20, 20]);
    const decoder = new SseDecoder();
    const datas = plan.steps
      .flatMap((s) => decoder.push(s.bytes))
      .flatMap((i) => (i.kind === 'event' ? [i.event.data] : []));
    expect(datas).toEqual(rec.events.map((e) => e.data));
    expect(datas.at(-1)).toBe('[DONE]');
  });

  it('supports fixed timing', () => {
    const rec = createRecording(capturedSession(), { toolVersion: '0', seed: null });
    const plan = createReplayPlan(rec, { kind: 'fixed', gapMs: 100 });
    expect(plan.steps.map((s) => s.atMs)).toEqual([100, 200, 300, 400]);
    expect(plan.ending.atMs).toBe(400);
  });

  it('validates timing', () => {
    const rec = createRecording(capturedSession(), { toolVersion: '0', seed: null });
    expect(() => createReplayPlan(rec, { kind: 'scaled', factor: 0 })).toThrow(RangeError);
    expect(() => createReplayPlan(rec, { kind: 'fixed', gapMs: -1 })).toThrow(RangeError);
  });

  it('reproduces fault disconnect modes', () => {
    const detail = {
      ...capturedSession(),
      termination: { kind: 'fault-disconnect' as const, atMs: 45, detail: 'mode=destroy' },
    };
    const plan = createReplayPlan(createRecording(detail, { toolVersion: '0', seed: null }));
    expect(plan.ending.mode).toBe('destroy');
  });

  it('aborts promptly', async () => {
    const rec = createRecording(capturedSession(), { toolVersion: '0', seed: null });
    const plan = createReplayPlan(rec, { kind: 'fixed', gapMs: 60_000 });
    const c = new AbortController();
    const { sink } = memorySink();
    const pending = runReplay(plan, sink, c.signal);
    setTimeout(() => c.abort(), 5);
    expect(await pending).toBe('aborted');
  });

  it('decoded replay output preserves event order', () => {
    const rec = createRecording(capturedSession(), {
      toolVersion: '0',
      seed: null,
      includePayloads: true,
    });
    const plan = createReplayPlan(rec);
    const joined = plan.steps.map((s) => dec.decode(s.bytes)).join('');
    expect(joined.indexOf('secret')).toBeLessThan(joined.indexOf('[DONE]'));
  });
});
