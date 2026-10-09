// Server side of the proxy benchmark, run in its own process so client-side
// timing is not distorted by sharing one event loop with the proxy.
import { createServer } from 'node:http';
import { createTokenFaultServer } from '../packages/proxy/dist/index.js';

const events = Number(process.argv[2]);
const enc = new TextEncoder();
const parts = [];
for (let i = 0; i < events; i++) {
  parts.push(
    `data: ${JSON.stringify({ id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: 1, model: 'bench', choices: [{ index: 0, delta: { content: ` token${i} héllo 世界` }, finish_reason: null }] })}\n\n`,
  );
}
parts.push('data: [DONE]\n\n');
const payload = enc.encode(parts.join(''));

const upstream = createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < payload.length; i += 4096) {
      if (!res.write(payload.subarray(i, i + 4096))) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const target = `http://127.0.0.1:${upstream.address().port}`;
const on = createTokenFaultServer({
  target,
  port: 0,
  capturePayloads: true,
  limits: { maxSessions: 4 },
});
const off = createTokenFaultServer({
  target,
  port: 0,
  capturePayloads: false,
  limits: { maxSessions: 4 },
});
const urls = { direct: target, captureOn: await on.listen(), captureOff: await off.listen() };

process.on('message', (msg) => {
  if (msg === 'memory') {
    globalThis.gc?.();
    process.send({
      heapUsedMiB: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
      sessions: on.store.size,
    });
  }
});
process.send({ urls, bytes: payload.length });
