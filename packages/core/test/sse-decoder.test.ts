import { describe, expect, it } from 'vitest';
import { SseDecoder, firstInvalidUtf8Index } from '../src/sse/decoder.js';
import type { SseItem } from '../src/sse/decoder.js';

const enc = new TextEncoder();

function decodeAll(chunks: readonly Uint8Array[], options = {}): SseItem[] {
  const decoder = new SseDecoder(options);
  const items: SseItem[] = [];
  for (const chunk of chunks) items.push(...decoder.push(chunk));
  items.push(...decoder.end());
  return items;
}

function events(items: readonly SseItem[]) {
  return items.flatMap((i) => (i.kind === 'event' ? [i.event] : []));
}

function diagnostics(items: readonly SseItem[]) {
  return items.flatMap((i) => (i.kind === 'diagnostic' ? [i.diagnostic] : []));
}

/** Deterministic PRNG for partition fuzzing. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function partition(bytes: Uint8Array, rand: () => number, maxSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    const size = 1 + Math.floor(rand() * maxSize);
    out.push(bytes.subarray(i, i + size));
    i += size;
  }
  return out;
}

describe('SseDecoder basics', () => {
  it('parses a single event', () => {
    const [evt] = events(decodeAll([enc.encode('data: hello\n\n')]));
    expect(evt).toMatchObject({
      type: 'message',
      data: 'hello',
      id: null,
      retry: null,
      startOffset: 0,
      endOffset: 13,
    });
  });

  it('parses multiple events in one chunk', () => {
    const evts = events(decodeAll([enc.encode('data: a\n\ndata: b\n\nevent: x\ndata: c\n\n')]));
    expect(evts.map((e) => [e.type, e.data])).toEqual([
      ['message', 'a'],
      ['message', 'b'],
      ['x', 'c'],
    ]);
  });

  it('joins multi-line data with LF', () => {
    const [evt] = events(
      decodeAll([enc.encode('data: line1\ndata:line2\ndata\ndata:  two spaces\n\n')]),
    );
    expect(evt?.data).toBe('line1\nline2\n\n two spaces');
  });

  it('strips exactly one leading space from values', () => {
    const [evt] = events(decodeAll([enc.encode('data:no-space\n\n')]));
    expect(evt?.data).toBe('no-space');
  });

  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
  ])('supports %s line endings', (_name, nl) => {
    const text = `event: e${nl}id: 7${nl}data: x${nl}${nl}data: y${nl}${nl}`;
    const evts = events(decodeAll([enc.encode(text)]));
    expect(evts.map((e) => [e.type, e.id, e.data])).toEqual([
      ['e', '7', 'x'],
      ['message', null, 'y'],
    ]);
    expect(evts[1]?.lastEventId).toBe('7');
  });

  it('handles CRLF split across chunks without inventing an empty line', () => {
    const items = decodeAll([
      enc.encode('data: a\r'),
      enc.encode('\ndata: b\r'),
      enc.encode('\n\r'),
      enc.encode('\n'),
    ]);
    expect(events(items).map((e) => e.data)).toEqual(['a\nb']);
    expect(diagnostics(items)).toEqual([]);
  });

  it('emits comments and does not dispatch comment-only blocks', () => {
    const items = decodeAll([enc.encode(': keep-alive\n\n:raw\n\ndata: x\n\n')]);
    expect(
      items.filter((i) => i.kind === 'comment').map((i) => (i.kind === 'comment' ? i.text : '')),
    ).toEqual(['keep-alive', 'raw']);
    expect(events(items)).toHaveLength(1);
    expect(diagnostics(items)).toEqual([]);
  });

  it('applies id/retry rules', () => {
    const items = decodeAll([
      enc.encode('id: a\u0000b\nretry: 12x\nretry: 3000\ndata: x\n\nid\ndata: y\n\n'),
    ]);
    const evts = events(items);
    expect(evts[0]).toMatchObject({ id: null, retry: 3000, lastEventId: '' });
    expect(evts[1]).toMatchObject({ id: '', lastEventId: '' });
    expect(diagnostics(items).map((d) => d.code)).toEqual([
      'sse-id-contains-null',
      'sse-invalid-retry',
    ]);
  });

  it('keeps lastEventId across events', () => {
    const evts = events(decodeAll([enc.encode('id: 1\ndata: a\n\ndata: b\n\n')]));
    expect(evts.map((e) => [e.id, e.lastEventId])).toEqual([
      ['1', '1'],
      [null, '1'],
    ]);
  });

  it('reports unknown fields and lines without a colon', () => {
    const items = decodeAll([enc.encode('foo: bar\nnonsense\ndata: x\n\n')]);
    expect(events(items)).toHaveLength(1);
    expect(diagnostics(items).map((d) => d.code)).toEqual([
      'sse-unknown-field',
      'sse-unknown-field',
    ]);
  });

  it('does not dispatch blocks without data and reports them', () => {
    const items = decodeAll([enc.encode('event: ping\n\n')]);
    expect(events(items)).toHaveLength(0);
    expect(diagnostics(items).map((d) => d.code)).toEqual(['sse-empty-event']);
  });

  it('dispatches an event whose data is empty', () => {
    const [evt] = events(decodeAll([enc.encode('data\n\n')]));
    expect(evt?.data).toBe('');
  });

  it('strips a leading BOM only at stream start', () => {
    const items = decodeAll([
      new Uint8Array([0xef, 0xbb]),
      new Uint8Array([0xbf]),
      enc.encode('data: x\n\n'),
    ]);
    expect(events(items).map((e) => e.data)).toEqual(['x']);
    expect(diagnostics(items).map((d) => d.code)).toEqual(['sse-bom']);
  });

  it('reports and discards an unterminated event at end of stream', () => {
    const items = decodeAll([enc.encode('data: complete\n\ndata: partial\n')]);
    expect(events(items).map((e) => e.data)).toEqual(['complete']);
    const [d] = diagnostics(items);
    expect(d).toMatchObject({ code: 'sse-truncated-event', severity: 'warning', offset: 16 });
  });

  it('reports an unterminated line at end of stream', () => {
    const items = decodeAll([enc.encode('data: no newline')]);
    expect(events(items)).toHaveLength(0);
    expect(diagnostics(items).map((d) => d.code)).toEqual(['sse-truncated-event']);
  });

  it('end() on an empty stream is silent', () => {
    expect(decodeAll([])).toEqual([]);
  });

  it('rejects push after end', () => {
    const d = new SseDecoder();
    d.end();
    expect(() => d.push(enc.encode('x'))).toThrow(/after end/);
  });

  it('validates options', () => {
    expect(() => new SseDecoder({ maxEventBytes: 1 })).toThrow(RangeError);
  });

  it('records byte offsets (a CRLF blank line ends the event at its CR)', () => {
    const evts = events(decodeAll([enc.encode('data: a\n\n: c\n\ndata: bb\r\n\r\ndata: c\n\n')]));
    expect(evts.map((e) => [e.startOffset, e.endOffset])).toEqual([
      [0, 9],
      [14, 25],
      [26, 35],
    ]);
  });
});

describe('SseDecoder UTF-8 handling', () => {
  it('decodes multi-byte characters split at every possible byte boundary', () => {
    const text = 'data: héllo 世界 🚀 مرحبا\n\n';
    const bytes = enc.encode(text);
    for (let split = 1; split < bytes.length; split++) {
      const items = decodeAll([bytes.subarray(0, split), bytes.subarray(split)]);
      expect(events(items).map((e) => e.data)).toEqual(['héllo 世界 🚀 مرحبا']);
      expect(diagnostics(items)).toEqual([]);
    }
  });

  it('decodes when fed one byte at a time', () => {
    const bytes = enc.encode('data: 🚀🚀\n\n');
    const items = decodeAll([...bytes].map((b) => new Uint8Array([b])));
    expect(events(items)[0]?.data).toBe('🚀🚀');
    expect(events(items)[0]?.dataByteLength).toBe(8);
  });

  it('reports invalid UTF-8 with the offending offset and substitutes U+FFFD', () => {
    const bytes = new Uint8Array([...enc.encode('data: ok'), 0xc3, 0x28, ...enc.encode('\n\n')]);
    const items = decodeAll([bytes]);
    expect(events(items)[0]?.data).toBe('ok�(');
    expect(diagnostics(items)).toEqual([
      expect.objectContaining({ code: 'sse-invalid-utf8', severity: 'error', offset: 8 }),
    ]);
  });

  it.each([
    ['overlong', [0xc0, 0xaf]],
    ['surrogate', [0xed, 0xa0, 0x80]],
    ['beyond U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['truncated', [0xe4, 0xb8]],
    ['lone continuation', [0x80]],
  ])('firstInvalidUtf8Index flags %s sequences', (_name, seq) => {
    expect(firstInvalidUtf8Index(new Uint8Array([0x41, ...seq]))).toBe(1);
  });

  it('firstInvalidUtf8Index accepts valid text', () => {
    expect(firstInvalidUtf8Index(enc.encode('aé世🚀\u{10FFFF}'))).toBe(-1);
  });
});

describe('SseDecoder bounded memory', () => {
  it('discards an oversized event and resynchronises at the next blank line', () => {
    const big = `data: ${'x'.repeat(500)}\n\n`;
    const items = decodeAll([enc.encode(`data: before\n\n${big}data: after\n\n`)], {
      maxEventBytes: 128,
    });
    expect(events(items).map((e) => e.data)).toEqual(['before', 'after']);
    expect(diagnostics(items).map((d) => d.code)).toEqual(['sse-event-too-large']);
  });

  it('discards an oversized single line split across many chunks', () => {
    const bytes = enc.encode(`data: ${'y'.repeat(1000)}\ndata: more\n\ndata: ok\n\n`);
    const items = decodeAll(partition(bytes, mulberry32(3), 17), { maxEventBytes: 64 });
    expect(events(items).map((e) => e.data)).toEqual(['ok']);
    expect(diagnostics(items).map((d) => d.code)).toEqual(['sse-event-too-large']);
  });

  it('handles a block of many small lines exceeding the limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `data: ${i}\n`).join('');
    const items = decodeAll([enc.encode(`${lines}\ndata: ok\n\n`)], { maxEventBytes: 64 });
    expect(events(items).map((e) => e.data)).toEqual(['ok']);
    expect(diagnostics(items).map((d) => d.code)).toEqual(['sse-event-too-large']);
  });

  it('decodes a large stream in one push', () => {
    const parts: string[] = [];
    for (let i = 0; i < 5000; i++) parts.push(`data: {"i":${i},"s":"${'z'.repeat(40)}"}\n\n`);
    const items = decodeAll([enc.encode(parts.join(''))]);
    expect(events(items)).toHaveLength(5000);
  });
});

describe('SseDecoder partition invariance (AC-1.1)', () => {
  const corpus = [
    'data: {"choices":[{"delta":{"content":"Hi 👋"}}]}\n\n',
    ': comment line\r\n\r\n',
    'event: custom\r\nid: 42\r\nretry: 1500\r\ndata: a\r\ndata: b\r\n\r\n',
    'data: 世界\r\rdata: [DONE]\n\n',
    'bogus\n\n',
    'data: tail without terminator',
  ].join('');
  const bytes = enc.encode(corpus);
  const reference = decodeAll([bytes]);

  it('produces identical output for 1-byte chunks', () => {
    expect(decodeAll([...bytes].map((b) => new Uint8Array([b])))).toEqual(reference);
  });

  it('produces identical output for 200 random partitions', () => {
    const rand = mulberry32(20261009);
    for (let i = 0; i < 200; i++) {
      expect(decodeAll(partition(bytes, rand, 1 + Math.floor(rand() * 40)))).toEqual(reference);
    }
  });

  it('reference output is what we expect', () => {
    expect(events(reference).map((e) => [e.type, e.data])).toEqual([
      ['message', '{"choices":[{"delta":{"content":"Hi 👋"}}]}'],
      ['custom', 'a\nb'],
      ['message', '世界'],
      ['message', '[DONE]'],
    ]);
    expect(diagnostics(reference).map((d) => d.code)).toEqual([
      'sse-unknown-field',
      'sse-empty-event',
      'sse-truncated-event',
    ]);
  });
});
