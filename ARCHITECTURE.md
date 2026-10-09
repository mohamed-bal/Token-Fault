# Architecture

This document describes TokenFault's components, data flow and package boundaries. The reasoning behind
individual choices is recorded in [docs/engineering/DECISIONS.md](docs/engineering/DECISIONS.md).

## Design principles

1. **Correctness first.** Byte-level SSE decoding is chunk-invariant: any partition of a byte stream yields
   the same events. Property tests with random partitions enforce this.
2. **Measure, never estimate.** Metrics come from I/O timestamps or API-reported values only.
3. **Deterministic faults.** Fault planning is a pure function of the profile, the seed and the observed frames.
4. **Honest failures.** An upstream failure is never turned into a clean end of stream. Every exchange ends
   with exactly one recorded termination.
5. **Bounded everything.** Every buffer, collection and input has an explicit limit.
6. **Safe defaults.** Loopback binding, a fixed upstream, a loopback-only control plane, no payloads on disk by default.

## Packages and dependency graph

```text
                         ┌──────────────┐
                         │   shared     │  wire contracts · limits · redaction (no deps, browser-safe)
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │    core      │  SSE · chat interpreter · inspector · faults · recording · replay
                         │  core/node   │  Node adapters: backpressured writes, terminations, measuring client
                         └──┬───────┬───┘
                ┌───────────┘       └────────────┐
         ┌──────▼──────┐                  ┌──────▼──────┐
         │  mock-llm   │                  │    proxy    │  data path · sessions · control API · live feed
         └──────┬──────┘                  └──────┬──────┘  · recorder · replay · Studio host
                └────────────┬───────────────────┘
                     ┌───────▼───────┐       ┌──────────────┐
                     │ testing · cli │       │   studio     │ (types from shared only; talks HTTP to proxy)
                     └───────────────┘       └──────────────┘
```

Boundary rules (enforced by ESLint and TypeScript project references):

- `shared` and the root entry of `core` never import `node:*`. Studio and other browser code can use them.
- `mock-llm` and `proxy` do not depend on each other. `testing` and `cli` compose them.
- The Studio depends only on `shared` types and the HTTP control API.

## Streaming core (`@tokenfault/core`)

The layers are distinct and never conflated:

| Layer               | Unit                            | Component                                           |
| ------------------- | ------------------------------- | --------------------------------------------------- |
| Network             | byte chunk (one read/write)     | `CapturedChunk`, `SseFramer`                        |
| SSE                 | event block (blank-line framed) | `SseDecoder` → `SseEvent`                           |
| JSON payload        | `data` of one event             | `interpretChatEventData`                            |
| Model content       | `choices[].delta.content`       | `ChatStreamAccumulator`                             |
| Tool-call fragments | `choices[].delta.tool_calls[]`  | `ChatStreamAccumulator` (assembles, validates JSON) |

- **`SseDecoder`** splits lines on raw bytes (CR, LF and CRLF, including a CRLF split across chunks), then decodes
  each complete line as UTF-8. Invalid UTF-8 is reported with its byte offset. Field handling follows the WHATWG
  rules. An unterminated block at EOF is reported (`sse-truncated-event`), not dispatched. A block larger than
  `maxEventBytes` is discarded, and the decoder resynchronises at the next blank line.
- **`SseFramer`** splits a byte stream into raw frames whose concatenation equals the input. The proxy uses it to
  apply event-level faults without re-encoding anything.
- **`interpretChatEventData`** maps one `data` payload to `chunk` | `done` | `error` | `invalid-json` | `unrecognized`.
  `[DONE]` belongs to this protocol layer, not to SSE. Unknown keys are reported, never dropped.
- **`StreamInspector`** combines the above with exact timing metrics and bounded capture. The proxy, the CLI, the
  testing helpers and replay all use it.

## Fault engine

```text
FaultProfile (zod-validated, seeded)
   │
   ├─ preResponse()  → first-byte delay, HTTP error (before any byte is sent)
   ├─ timedDisconnect() → armed when headers are sent
   └─ planFrame(frame) / planEnd() → [wait | write | annotate | disconnect] actions
                                         │
                       FaultedResponseWriter (core/node) executes them with backpressure
```

`FaultPlanner` is pure and deterministic. Jitter and fragmentation use `mulberry32`, seeded per fault type via
`deriveSeed(seed, type)`, so adding one fault never shifts another fault's random sequence. Faults configured but
never triggered (stream too short) are annotated as such.

## Proxy data path

```text
client ─► onRequest guard (Host / loopback) ─► target lock (buildUpstreamUrl) ─► fault selection
       ─► pre-response faults ─► http(s).request(upstream, signal) ─► headers timeout
       ◄─ writeHead(status, filtered headers + x-tokenfault-session)
       ◄─ for await (chunk of upstream) { idle timer; writer.push(chunk) }   // backpressure: next read waits for the write
       ◄─ writer.end() → res.end()  |  terminate(destroy/reset) on failure
```

Termination mapping: client close → `client-abort` (aborts upstream); upstream error after headers → client
connection destroyed + `upstream-reset`; idle or total timeout → `upstream-timeout`; fault → `fault-disconnect`
(`mode=reset|destroy|end`); connect failure → `502` + `upstream-unreachable`; headers timeout → `504`.

## Sessions, live feed and control API

`SessionStore` keeps at most `maxSessions` sessions (oldest evicted first). It batches progress notifications
(default 50 ms) and notifies end listeners (the recorder). The live feed (`GET /__tokenfault/api/live`) is an SSE
stream that starts with a snapshot. A subscriber whose socket buffer exceeds `maxSubscriberBufferBytes` is
disconnected.

| Method & path                                                  | Purpose                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /__tokenfault/api/info`                                   | Server info (target without credentials, privacy settings, limits, active faults) |
| `GET /__tokenfault/api/health`                                 | Liveness                                                                          |
| `GET /__tokenfault/api/auth/status`                            | `{required, authenticated}` (no token needed)                                     |
| `POST /__tokenfault/api/auth/login`                            | `{token}` → session cookie (Studio sign-in); 401 / 429 on failure                 |
| `POST /__tokenfault/api/auth/logout`                           | Ends the cookie session                                                           |
| `GET /__tokenfault/api/scenarios`                              | Scenario and fault-type catalogue                                                 |
| `GET/DELETE /__tokenfault/api/sessions`                        | List / clear sessions                                                             |
| `GET /__tokenfault/api/sessions/:id[?chunks=false]`            | Session detail                                                                    |
| `GET /__tokenfault/api/sessions/:id/recording[?payloads=true]` | Export a recording (finished sessions only)                                       |
| `GET /__tokenfault/api/live`                                   | Live SSE feed of `LiveMessage`s                                                   |
| `GET/PUT/DELETE /__tokenfault/api/faults`                      | Server-wide fault selection (`{scenarioId}` or `{profile}`)                       |
| `POST /__tokenfault/api/replays`                               | Replay `{sessionId}` or `{recording}` with `{timing}` into a new session          |
| `POST /__tokenfault/api/probe`                                 | Send a sample streaming request through this proxy                                |

All control routes sit behind the guard described in the [threat model](docs/engineering/THREAT_MODEL.md). Except
`health`, the three `auth` routes and the static Studio assets, they also require the control token, either as
`Authorization: Bearer <token>` or as the Studio's session cookie (decision D-021). Unauthenticated requests get
`401` with `WWW-Authenticate: Bearer realm="tokenfault"`.

## Recording and replay

A recording (`schemaVersion: 1`) holds session metadata, metrics, termination, the fault profile and seed, events
(original data or a redacted skeleton), raw chunks (only with payloads) and fault annotations. A strict zod schema
validates it: unknown keys are rejected, sizes are bounded and timestamps must be monotonic.

`createReplayPlan` chooses **chunk mode** (byte-exact, needs payloads) or **event mode** (re-serialised events) and
applies `original | scaled | fixed` timing. `runReplay` schedules against absolute offsets, so timer drift does
not accumulate, and it reproduces how the stream ended (`end`, `destroy` or `reset`).

## Studio

A React 19 single-page app built by Vite into static files. The proxy serves it under `/__tokenfault/studio/`
with a strict CSP (`script-src 'self'`, no inline scripts). It uses hash routing, a virtualised event list, and
an SVG timeline batched per colour. All untrusted content is rendered as text nodes.

## Testing strategy

| Layer       | Location                               | What it proves                                                                                                           |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `packages/*/test`                      | Decoder invariants, interpreter, planner determinism, schemas, redaction, headers, target lock                           |
| Integration | `tests/integration`                    | Mock + proxy over real sockets: scenarios A–I, transport guarantees, security boundaries, recorder, replay, static files |
| Contract    | `tests/integration/openai-sdk.test.ts` | The official `openai` SDK consumes the stream and surfaces faults as SDK errors                                          |
| CLI smoke   | `scripts/cli-smoke.mjs`                | The built binary: commands, exit codes, signals, files                                                                   |
| E2E         | `tests/e2e` (Playwright)               | The full Studio journey in Chromium                                                                                      |
