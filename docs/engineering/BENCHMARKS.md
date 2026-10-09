# Benchmarks

Measurements of TokenFault's own overhead. They describe **one machine on one day**; they are not a CI gate and
not a promise for other hardware. Every number below was produced by the scripts in `bench/` on the environment
listed. Nothing is extrapolated.

## Environment

| Item     | Value                                                                       |
| -------- | --------------------------------------------------------------------------- |
| Date     | 2026-10-09                                                                  |
| Revision | `f0c04f3` (decoder and inspector fixes from the phase 2 audit included)     |
| Node.js  | v22.22.0, `--expose-gc`                                                     |
| OS / CPU | Linux x64, 4 × Intel Xeon @ 2.10 GHz (shared cloud VM), 15.7 GiB RAM        |
| Network  | Loopback only (`127.0.0.1`); upstream, proxy and client on the same machine |

The VM is shared, so run-to-run variation of ±15% is normal here. Compare numbers only within one run.

## Method

- `pnpm build && node --expose-gc bench/run.mjs [--quick] [--json out.json]` runs against the built packages.
- **Payload:** a synthetic OpenAI Chat Completions stream: N `chat.completion.chunk` events, each with a short
  multi-byte UTF-8 delta (`" token<i> héllo 世界"`), then `data: [DONE]`. An _event_ here is one SSE event, **not**
  a model token.
- **Core benchmarks** (decoder, inspector, recording, replay plan) run in-process: 3 warm-up iterations, then the
  median of 10 (5 for recording and replay), GC before each iteration. 50,001 events (≈ 8.8 MiB).
- **Proxy benchmarks** run the upstream and both proxies in a **separate child process**, so the measuring client
  does not share an event loop with the server. The upstream writes 100,001 events (17.6 MiB) in 4 KiB writes
  with backpressure. The client reads the whole body. One warm-up request, then the median of 8. _First byte_ is
  the time from sending the request to receiving the first body byte.
- **Memory:** heap used in the server process after GC, before and after 20 more full streams with payload
  capture on and `maxSessions: 4`.
- Throughput is reported in MiB/s (the JSON field is named `MBps`).

## Results

### Core (in-process, 50,001 events, 8.8 MiB)

| Benchmark                                            | Median | Throughput  | Events/s |
| ---------------------------------------------------- | ------ | ----------- | -------- |
| SSE decoder, 16 KiB chunks                           | 361 ms | 24.4 MiB/s  | 138,500  |
| SSE decoder, 1 KiB chunks                            | 368 ms | 23.9 MiB/s  | 135,794  |
| SSE decoder, 64-byte chunks                          | 317 ms | 27.8 MiB/s  | 157,603  |
| Inspector (decode + interpret + metrics), capture on | 372 ms | 23.7 MiB/s  | 134,503  |
| Inspector, capture off                               | 341 ms | 25.8 MiB/s  | 146,430  |
| Recording create + serialize, no payloads            | 268 ms | 32.9 MiB/s  | 186,713  |
| Recording create + serialize, with payloads          | 302 ms | 29.2 MiB/s  | 165,432  |
| Replay plan (chunk mode)                             | 59 ms  | 148.5 MiB/s | 842,684  |

### Proxy (separate server process, 100,001 events, 17.6 MiB per request)

| Path                          | Median | Throughput  | Events/s  | First byte (median) |
| ----------------------------- | ------ | ----------- | --------- | ------------------- |
| Direct to upstream (baseline) | 37 ms  | 481.7 MiB/s | 2,731,713 | 2.1 ms              |
| Through proxy, capture on     | 675 ms | 26.1 MiB/s  | 148,053   | 17.6 ms             |
| Through proxy, capture off    | 716 ms | 24.6 MiB/s  | 139,693   | 15.0 ms             |

| Memory (server process)                                      | Before    | After 20 streams | Sessions kept |
| ------------------------------------------------------------ | --------- | ---------------- | ------------- |
| Heap used, capture on, `maxSessions: 4`, 17.6 MiB per stream | 172.3 MiB | 170.9 MiB        | 4             |

### Reading the numbers

- The proxy is CPU-bound on inspection (decode, JSON parse, metrics) in one Node.js thread: its throughput is close
  to the inspector's in-process throughput, far below the raw loopback baseline. Capture on vs off is within the
  noise of this VM.
- The added first-byte latency is about 13–16 ms on this machine for this request shape (request parsing, body
  buffering, upstream connect, header forwarding).
- Retained memory is bounded by the session limits: after 20 more 17.6 MiB streams, the heap did not grow.
- These are ceilings for a single stream with a fast upstream. Real LLM streams are limited by the model, usually
  at far lower event rates; these benchmarks do not measure that.

## Before and after: decoder fix (PERF-1)

The phase 2 audit found the SSE decoder rescanning its buffered remainder on every line, which is quadratic in the
chunk size. Same script (`bench/decoder-ab.mjs`, 50,001 events, 8.8 MiB, median of 5 after 2 warm-ups), same machine,
same session, pre-fix build of `6fe5140` vs the fixed decoder:

| Chunk size | Before (`6fe5140`) | After          |
| ---------- | ------------------ | -------------- |
| 64 B       | 341–352 ms         | 287–315 ms     |
| 1 KiB      | 311–354 ms         | 388–391 ms     |
| 16 KiB     | 428–430 ms         | 372–432 ms     |
| 64 KiB     | **1,204–1,278 ms** | **377–422 ms** |
| 256 KiB    | **1,368 ms**       | **256 ms**     |

Ranges are the medians of two runs. Small-chunk differences are within the VM's noise. The fix removes the
dependence on chunk size: large reads, typical of a fast local upstream or of a replay, no longer slow the decoder
down by 3–5×.

The base64 fast path (PERF-2) was measured with a CPU profile during the audit: `bytesToBase64` went from 231 of
531 ms of inspector time to a negligible share. The equivalence of the native and portable encoders is covered by
a unit test.

## Reproducing

```bash
pnpm install && pnpm build
pnpm bench                # full run (about 2 minutes here)
pnpm bench -- --quick     # smaller payloads, fewer iterations
```

To compare the decoder against an older revision, build that revision's `@tokenfault/core` in a separate
checkout and run `node --expose-gc bench/decoder-ab.mjs <checkout>/packages/core/dist/index.js before`.

Report the environment block the script prints together with any numbers you publish.
