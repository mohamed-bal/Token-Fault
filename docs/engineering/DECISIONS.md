# Architecture Decision Log

Each entry records the decision, the alternatives considered, and why they were rejected.
Entries are append-only. A superseded decision is marked as such rather than deleted.

---

## D-001 — TypeScript strict, Node 22+, ESM-only, pnpm workspaces

**Decision.** All packages are ESM (`"type": "module"`) TypeScript compiled with `strict`,
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Node ≥ 22.12 is the runtime. The
workspace uses pnpm.

**Rejected alternatives.**

- _Dual CJS/ESM builds._ These double the build matrix and the testing surface. Node 22 supports
  `require(esm)`, so CJS consumers are not locked out.
- _npm/yarn workspaces._ pnpm's strict `node_modules` layout catches undeclared dependencies.
  Declaring dependencies explicitly matters in a monorepo whose packages have hard boundaries.

## D-002 — TypeScript 6.0, Vitest 4, Vite 7, ESLint 9 (not the newest majors)

**Decision.** Pin `typescript@6.0.3`, `vitest@4.1.x`, `vite@7.3.x`, `eslint@9.39.x`,
`@playwright/test@1.56.1`.

**Why.** `typescript-eslint` (needed for type-aware rules such as `no-floating-promises`, which is
critical in stream code) does not support TypeScript 7 yet. Vite 7 and Vitest 4 are stable and
compatible. Playwright 1.56.1 matches the pre-installed Chromium build (1194) in the
development environment. Every pinned version was published at least two weeks before
adoption.

## D-003 — Package layout and the mock server as a package

```
packages/shared    wire contracts, limits, redaction           (no runtime deps)
packages/core      SSE decoder, OpenAI interpreter, metrics,   (zod)
                   fault engine, recording, replay scheduling
                   + `@tokenfault/core/node` adapters
packages/mock-llm  OpenAI-compatible mock server                (fastify)
packages/proxy     streaming proxy + control API + Studio host  (fastify)
packages/testing   programmatic helpers for test suites
packages/cli       `tokenfault` binary
apps/studio        React UI (static bundle served by the proxy)
```

**Deviation from the directive.** The directive places the mock LLM under `examples/mock-llm`.
`tokenfault mock` and `tokenfault proxy --mock` need it at runtime, and a published CLI cannot
depend on an example directory. It is therefore `packages/mock-llm`. `examples/` contains only
runnable usage examples.

**Boundary rules.**

- `shared` and the root entry point of `core` must not import `node:*` modules, so Studio and
  other browser code can use them. This is enforced with ESLint `no-restricted-imports`.
  Node-specific adapters live behind the `@tokenfault/core/node` subpath.
- `proxy` and `mock-llm` do not depend on each other. `cli` and `testing` compose them.

## D-004 — Byte-level SSE line splitting

**Decision.** The SSE decoder splits lines on raw bytes (`0x0A`, `0x0D`) _before_ UTF-8 decoding,
then decodes each complete line.

**Why.** CR and LF can never appear inside a multi-byte UTF-8 sequence. Splitting at byte level
therefore:

1. correctly handles multi-byte characters split across network chunks, with no streaming
   decoder state;
2. gives exact byte offsets and raw byte lengths per event, which the inspector, the fault
   engine (frame re-chunking) and recordings rely on;
3. lets us validate UTF-8 per line and report _where_ invalid bytes occurred, instead of
   silently substituting U+FFFD.

**Rejected.** A `TextDecoderStream` followed by string splitting loses byte offsets and hides
invalid UTF-8.

## D-005 — `[DONE]` is a protocol-adapter concern

The SSE layer knows nothing about `[DONE]`. The OpenAI chat-completions interpreter treats the
literal data `[DONE]` as that protocol's terminator. A stream also counts as `completed` when
every choice reported a `finish_reason` and the transport ended cleanly. Some
OpenAI-compatible servers omit `[DONE]`. The completion signal is reported explicitly
(`done-marker` | `finish-reason`).

## D-006 — Proxy uses `node:http`/`node:https` for upstream, not `fetch`

**Decision.** Upstream requests use `http.request`/`https.request`. Bodies are piped with explicit
backpressure (`write()` return value + `drain`).

**Why.**

- `fetch` (undici) transparently decompresses bodies but keeps `content-encoding` headers.
  Forwarding those headers with decoded bytes corrupts responses.
- With `http.request`, the bytes we inspect are exactly the bytes we forward.
- Socket-level events (reset vs. clean end) map directly onto termination kinds.

The proxy sends `accept-encoding: identity` upstream so the stream can be inspected. If an
upstream compresses anyway, bytes are forwarded untouched and inspection reports
`transport-compressed-body` instead of producing garbage.

## D-007 — Fastify for HTTP servers, with raw response control for streams

Fastify provides routing, body limits, schema-less JSON parsing, error handling and pino logging
with redaction paths. Streaming responses use `reply.hijack()` plus the raw `ServerResponse`.
The fault engine needs byte- and timing-exact control, which Fastify's reply serialisation
does not give.

**Rejected.** `@fastify/static` for Studio assets. It adds a transitive tree (`glob`, `send`,
…) to serve a handful of files from one directory. A ~80-line handler with explicit
path-traversal checks is tested directly (`static-files.test.ts`).

## D-008 — Fault engine = pure planner + small executor

The fault engine is a pure function of `(fault profile, seed, observed frames)` that emits actions
(`wait`, `write`, `annotate`, `disconnect`). A separate executor performs actions against a sink
with backpressure and abort support.

**Why.** Planning is fully deterministic and unit-testable without timers or sockets. The same
planner drives both the proxy (real upstream) and the mock server (synthetic stream).

Pre-response faults (HTTP 429/503, first-byte delay) are a separate phase from in-stream faults.
Once headers are sent, the status cannot change, so an in-stream failure can only be a
disconnect, a stall, or malformed data.

Randomised faults (jitter, fragmentation) use a seeded PRNG (`mulberry32`). The seed is part of
the fault profile, and every session records it.

## D-009 — Transparent vs. framed forwarding

With no in-stream fault active, the proxy forwards upstream chunks exactly as received
(transparent mode): one client write per upstream read, with timing preserved. With an in-stream
fault active on an uncompressed 2xx SSE body, the proxy re-frames the stream into complete SSE
events (bounded by `maxEventBytes`) so faults can act on event boundaries. Bytes are never
re-encoded in either mode.

_Amendment (implementation):_ `content-length` from the upstream is never forwarded. Responses are
always streamed with chunked transfer encoding. This keeps the two modes consistent, and injected
frames would invalidate the length anyway.

## D-010 — Privacy defaults

| Data                                    | In memory (Studio)                             | On disk (recordings)                         |
| --------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| Request headers (incl. `Authorization`) | never                                          | never                                        |
| Request body (prompts)                  | never (only model, counts, size)               | never                                        |
| Response SSE payloads                   | yes, default; `--no-capture-payloads` disables | **no, default**; `--record-payloads` enables |
| Response headers                        | allowlist only                                 | allowlist only                               |
| Query-string values                     | redacted                                       | redacted                                     |

In-memory capture of response payloads is on by default. Without it, the inspector cannot do its
job. The data is bounded, ephemeral, and only reachable over the loopback-only control API.
Writing payloads to disk always requires an explicit flag.

## D-011 — Control plane is loopback-only, no CORS, DNS-rebinding protected

`/__tokenfault/*` accepts requests only when the TCP peer is a loopback address **and** the `Host`
header names a loopback host. State-changing requests must be `application/json`, and are
rejected when `Origin` or `Sec-Fetch-Site` indicates a cross-site caller. No
`Access-Control-Allow-*` headers are ever sent. This holds even when the proxy data path is
exposed with `--allow-remote`.

## D-012 — Recording format: versioned JSON, validated with zod, size-capped

Recordings are a single JSON document (`schemaVersion: 1`). Payload-free recordings keep the
event structure (field names, enums, numbers) but replace free-text strings with a redaction
marker. They can still be replayed at event level, with full timing.

**Rejected.** NDJSON streaming format. It is better for very large captures, but harder to
validate atomically. Captures are bounded by session limits anyway.

## D-013 — Licence

MIT, with copyright holder `mohamed-bal` (the confirmed GitHub owner of the repository). The
owner's legal name was not available. **Action for the owner:** confirm or amend the copyright
line in `LICENSE` before the first public release.

## D-014 — No hand-rolled CLI framework dependency

The CLI uses `node:util.parseArgs` with zod validation of the parsed options. Commander/yargs
were rejected: the command surface is small, and `parseArgs` is in the standard library.

## D-015 — Mock token usage is synthetic and labelled as such

The mock server reports `usage` only when the client asks (`stream_options.include_usage`).
The numbers are deterministic counts of emitted deltas, not tokenizer output, and the docs say
so. Studio shows `usage` only as "reported by API".

## D-016 — Mock-only scenarios are delegated through the proxy

`fragment-tool-calls` shapes _generated content_, so only the mock can apply it. If a request selects a
mock-only scenario with `x-tokenfault-scenario`, the proxy applies no faults itself, forwards the scenario
header upstream, and records a `delegated` annotation. Server-wide selection of a mock-only scenario via the
control API is still rejected, because it would silently do nothing against a real provider.

**Rejected.** Rejecting the request with 400. That broke the natural Studio flow (proxy → mock) for scenario I.

## D-017 — Host-header check on the data path

While the proxy is bound to loopback, every request (not only control-plane requests) must carry a loopback
`Host` header. Legitimate local clients always do. A DNS-rebinding web page cannot. `--allow-remote` disables
the check for the data path only.

## D-018 — Contract tests use the official `openai` SDK (dev dependency only)

"OpenAI-compatible" is only claimed because the official `openai` Node SDK (5.23.2) consumes the mock and the
proxy correctly, and surfaces injected faults as its own error types (`tests/integration/openai-sdk.test.ts`).
The SDK is a test-only dependency of the private integration-test package.

## D-019 — Request bodies are buffered (bounded)

The proxy buffers the request body (≤ `maxRequestBodyBytes`, 20 MiB by default) before forwarding. This lets it
record non-sensitive request facts (model, stream flag, counts) without keeping the prompt, and keeps
pre-response fault handling simple. Response bodies are always streamed.
