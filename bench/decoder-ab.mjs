// Decoder-only A/B benchmark: the same input and chunkings against any built
// @tokenfault/core, e.g. a checkout of an older revision.
//
// Usage: node --expose-gc bench/decoder-ab.mjs <path/to/core/dist/index.js> <label> [chunkSizes]
//   chunkSizes: comma-separated bytes, default 64,1024,16384,65536
// Prints one JSON line per chunk size: median of 5 runs after 2 warm-ups.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [, , distIndex, label = 'run'] = process.argv;
if (!distIndex) {
  console.error('usage: decoder-ab.mjs <core dist/index.js> [label] [chunkSizes]');
  process.exit(2);
}
const { SseDecoder } = await import(pathToFileURL(path.resolve(distIndex)).href);
const enc = new TextEncoder();
const parts = [];
for (let i = 0; i < 50_000; i++)
  parts.push(
    `data: ${JSON.stringify({ id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench', choices: [{ index: 0, delta: { content: ` token${i} héllo 世界` }, finish_reason: null }] })}\n\n`,
  );
parts.push('data: [DONE]\n\n');
const payload = enc.encode(parts.join(''));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
};
for (const size of (process.argv[4] ?? '64,1024,16384,65536').split(',').map(Number)) {
  const times = [];
  for (let it = 0; it < 7; it++) {
    globalThis.gc?.();
    const t0 = performance.now();
    const d = new SseDecoder();
    let n = 0;
    for (let i = 0; i < payload.length; i += size)
      for (const item of d.push(payload.subarray(i, i + size))) if (item.kind === 'event') n++;
    for (const item of d.end()) if (item.kind === 'event') n++;
    const ms = performance.now() - t0;
    if (it >= 2) times.push(ms);
    if (n !== 50_001) throw new Error(`events ${n}`);
  }
  const m = median(times);
  console.log(
    JSON.stringify({
      label,
      chunkBytes: size,
      medianMs: +m.toFixed(1),
      MBps: +(payload.length / 1048576 / (m / 1000)).toFixed(1),
    }),
  );
}
