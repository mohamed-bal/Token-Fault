// TokenFault benchmark suite (measurement only; not a CI gate).
//
// Usage: pnpm build && node --expose-gc bench/run.mjs [--quick] [--json out.json]
// Runs against the built packages (packages/*/dist). All traffic is loopback.
// Reports medians over measured iterations after warmup. Results are specific to
// the machine they were produced on.
import { fork } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { writeFile } from 'node:fs/promises';
import {
  SseDecoder,
  StreamInspector,
  createRecording,
  createReplayPlan,
  sessionDetail,
  serializeRecording,
} from '../packages/core/dist/index.js';

const QUICK = process.argv.includes('--quick');
const jsonOut = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : null;
const enc = new TextEncoder();
const results = [];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const gc = () => globalThis.gc?.();

function syntheticStream(events) {
  const parts = [];
  for (let i = 0; i < events; i++) {
    parts.push(
      `data: ${JSON.stringify({ id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench', choices: [{ index: 0, delta: { content: ` token${i} héllo 世界` }, finish_reason: null }] })}\n\n`,
    );
  }
  parts.push('data: [DONE]\n\n');
  return enc.encode(parts.join(''));
}

function chunk(bytes, size) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

function bench(name, { warmup, iterations, bytes, events }, fn) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    gc();
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  const ms = median(times);
  const row = {
    name,
    medianMs: +ms.toFixed(2),
    minMs: +Math.min(...times).toFixed(2),
    maxMs: +Math.max(...times).toFixed(2),
    MBps: bytes ? +(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1) : null,
    eventsPerSec: events ? Math.round(events / (ms / 1000)) : null,
    iterations,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

// ---------------------------------------------------------------- core
const EVENTS = QUICK ? 5_000 : 50_000;
const stream = syntheticStream(EVENTS);
const cfg = {
  warmup: QUICK ? 1 : 3,
  iterations: QUICK ? 3 : 10,
  bytes: stream.length,
  events: EVENTS + 1,
};
for (const size of [16 * 1024, 1024, 64]) {
  const chunks = chunk(stream, size);
  bench(`decoder: ${EVENTS + 1} events, ${size}-byte chunks`, cfg, () => {
    const d = new SseDecoder();
    let n = 0;
    for (const c of chunks) for (const it of d.push(c)) if (it.kind === 'event') n++;
    d.end();
    if (n !== EVENTS + 1) throw new Error(`decoded ${n}`);
  });
}
{
  const chunks = chunk(stream, 1024);
  for (const capture of [true, false]) {
    bench(`inspector (decode+interpret+metrics), capture=${capture}`, cfg, () => {
      const insp = new StreamInspector({
        capturePayloads: capture,
        limits: {
          maxEventsPerSession: 1e7,
          maxChunksPerSession: 1e7,
          maxCapturedBytesPerSession: 1e9,
        },
      });
      insp.onHeaders(200, { 'content-type': 'text/event-stream' }, 0);
      let t = 0;
      for (const c of chunks) insp.onChunk(c, (t += 0.01));
      insp.onEnd({ kind: 'eof', atMs: t, detail: null });
    });
  }
}
{
  // Recording + replay planning on a large captured session.
  const insp = new StreamInspector({
    limits: { maxEventsPerSession: 1e7, maxChunksPerSession: 1e7, maxCapturedBytesPerSession: 1e9 },
  });
  insp.onHeaders(200, { 'content-type': 'text/event-stream' }, 0);
  let t = 0;
  for (const c of chunk(stream, 1024)) insp.onChunk(c, (t += 0.01));
  insp.onEnd({ kind: 'eof', atMs: t, detail: null });
  const detail = sessionDetail(
    {
      id: 'bench',
      source: 'proxy',
      startedAt: new Date(0).toISOString(),
      method: 'POST',
      path: '/v1/chat/completions',
      scenarioId: null,
      faults: [],
      request: { model: 'bench', stream: true, messageCount: 1, toolCount: null, bodyBytes: 1 },
      replayOf: null,
    },
    insp,
    [],
  );
  for (const includePayloads of [false, true]) {
    bench(
      `recording: create+serialize, payloads=${includePayloads}`,
      { ...cfg, iterations: QUICK ? 2 : 5 },
      () => {
        serializeRecording(
          createRecording(detail, { toolVersion: 'bench', seed: null, includePayloads }),
        );
      },
    );
  }
  const rec = createRecording(detail, { toolVersion: 'bench', seed: null, includePayloads: true });
  bench('replay: plan (chunk mode)', { ...cfg, iterations: QUICK ? 2 : 5 }, () =>
    createReplayPlan(rec),
  );
}

// ---------------------------------------------------------------- proxy
// Upstream and proxies run in a child process; this process only acts as the client.
function fetchAll(url) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let first = null;
    let bytes = 0;
    const req = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 } },
      (res) => {
        res.on('data', (c) => {
          first ??= performance.now() - t0;
          bytes += c.length;
        });
        res.on('end', () => resolve({ ms: performance.now() - t0, firstMs: first, bytes }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

const PROXY_EVENTS = QUICK ? 20_000 : 100_000;
const server = fork(
  fileURLToPath(new URL('./proxy-server.mjs', import.meta.url)),
  [String(PROXY_EVENTS)],
  { execArgv: ['--expose-gc'] },
);
const { urls, bytes: payloadBytes } = await new Promise((r) => server.once('message', r));

async function benchHttp(name, url) {
  const iters = QUICK ? 3 : 8;
  await fetchAll(url);
  const times = [];
  const firsts = [];
  for (let i = 0; i < iters; i++) {
    const r = await fetchAll(url);
    if (r.bytes !== payloadBytes) throw new Error(`${name}: got ${r.bytes} bytes`);
    times.push(r.ms);
    firsts.push(r.firstMs);
  }
  const ms = median(times);
  const row = {
    name,
    medianMs: +ms.toFixed(2),
    minMs: +Math.min(...times).toFixed(2),
    maxMs: +Math.max(...times).toFixed(2),
    MBps: +(payloadBytes / 1024 / 1024 / (ms / 1000)).toFixed(1),
    eventsPerSec: Math.round((PROXY_EVENTS + 1) / (ms / 1000)),
    firstByteMedianMs: +median(firsts).toFixed(2),
    iterations: iters,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

const size = `${(payloadBytes / 1024 / 1024).toFixed(1)} MiB`;
await benchHttp(
  `direct upstream: ${PROXY_EVENTS + 1} events, ${size}`,
  `${urls.direct}/v1/chat/completions`,
);
await benchHttp('proxy, payload capture on: same stream', `${urls.captureOn}/v1/chat/completions`);
await benchHttp(
  'proxy, payload capture off: same stream',
  `${urls.captureOff}/v1/chat/completions`,
);

{
  const memory = () =>
    new Promise((r) => {
      server.once('message', r);
      server.send('memory');
    });
  const before = await memory();
  const rounds = QUICK ? 5 : 20;
  for (let i = 0; i < rounds; i++) await fetchAll(`${urls.captureOn}/v1/chat/completions`);
  const after = await memory();
  const row = {
    name: `memory (server process): ${rounds} more streams x ${size} with capture on, maxSessions=4`,
    heapBeforeMiB: before.heapUsedMiB,
    heapAfterMiB: after.heapUsedMiB,
    sessionsRetained: after.sessions,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
server.kill();

const env = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: `${os.cpus().length} x ${os.cpus()[0]?.model ?? 'unknown'}`,
  memoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
  gcExposed: typeof globalThis.gc === 'function',
  quick: QUICK,
  date: new Date().toISOString(),
};
console.log(JSON.stringify({ env }));
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ env, results }, null, 2));
