import { describe, expect, it } from 'vitest';
import { SseFramer } from '../src/sse/framer.js';
import { serializeSseComment, serializeSseEvent } from '../src/sse/encoder.js';
import { SseDecoder } from '../src/sse/decoder.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function frameAll(chunks: readonly Uint8Array[], maxFrameBytes?: number) {
  const framer = new SseFramer(maxFrameBytes === undefined ? {} : { maxFrameBytes });
  const frames = chunks.flatMap((c) => framer.push(c));
  frames.push(...framer.end());
  return frames;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

describe('SseFramer', () => {
  const stream = 'data: a\n\nevent: x\r\ndata: b\r\n\r\n: c\r\rdata: 世界\n\ndata: tail';

  it('splits at blank lines with any line ending, preserving every byte', () => {
    const frames = frameAll([enc.encode(stream)]);
    expect(frames.map((f) => [dec.decode(f.bytes), f.complete])).toEqual([
      ['data: a\n\n', true],
      ['event: x\r\ndata: b\r\n\r\n', true],
      [': c\r\r', true],
      ['data: 世界\n\n', true],
      ['data: tail', false],
    ]);
  });

  it('is invariant under 1-byte chunking', () => {
    const bytes = enc.encode(stream);
    const a = frameAll([bytes]).map((f) => [dec.decode(f.bytes), f.complete]);
    const b = frameAll([...bytes].map((x) => new Uint8Array([x]))).map((f) => [
      dec.decode(f.bytes),
      f.complete,
    ]);
    expect(b).toEqual(a);
  });

  it('concatenation of frames equals the input for every 2-way split', () => {
    const bytes = enc.encode(stream);
    for (let i = 1; i < bytes.length; i++) {
      const frames = frameAll([bytes.subarray(0, i), bytes.subarray(i)]);
      expect(concat(frames.map((f) => f.bytes))).toEqual(bytes);
    }
  });

  it('keeps the LF of a CRLF blank line split across chunks in the same frame', () => {
    const frames = frameAll([enc.encode('data: a\r\n\r'), enc.encode('\ndata: b\n\n')]);
    expect(frames.map((f) => dec.decode(f.bytes))).toEqual(['data: a\r\n\r\n', 'data: b\n\n']);
  });

  it('flushes an oversized frame as incomplete to bound memory', () => {
    const frames = frameAll(
      [enc.encode(`data: ${'x'.repeat(100)}`), enc.encode('\n\ndata: ok\n\n')],
      32,
    );
    expect(frames.map((f) => f.complete)).toEqual([false, true, true]);
    expect(concat(frames.map((f) => f.bytes))).toEqual(
      enc.encode(`data: ${'x'.repeat(100)}\n\ndata: ok\n\n`),
    );
  });
});

describe('serializeSseEvent', () => {
  it('round-trips through the decoder', () => {
    const text = serializeSseEvent({
      event: 'update',
      id: '9',
      retry: 100,
      data: 'line1\nline2\r\nline3',
    });
    expect(text).toBe(
      'event: update\nid: 9\nretry: 100\ndata: line1\ndata: line2\ndata: line3\n\n',
    );
    const decoder = new SseDecoder();
    const [item] = decoder.push(enc.encode(text));
    expect(item).toMatchObject({
      kind: 'event',
      event: { type: 'update', id: '9', retry: 100, data: 'line1\nline2\nline3' },
    });
  });

  it('rejects values that would break framing', () => {
    expect(() => serializeSseEvent({ data: 'x', event: 'a\nb' })).toThrow(TypeError);
    expect(() => serializeSseEvent({ data: 'x', id: 'a\rb' })).toThrow(TypeError);
    expect(() => serializeSseEvent({ data: 'x', id: 'a\u0000' })).toThrow(TypeError);
    expect(() => serializeSseEvent({ data: 'x', retry: -1 })).toThrow(TypeError);
  });

  it('serialises comments', () => {
    expect(serializeSseComment('ping\npong')).toBe(': ping\n: pong\n\n');
  });
});
