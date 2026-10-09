# Implementation Status

- **Last updated:** 2026-10-09
- **Version:** 0.1.0 (unreleased)
- **Environment of record:** Linux x64, Node.js 22.22.0, pnpm 10.28.0, Chromium 1194 (Playwright 1.56.1)

This file reports the state that was **verified**, not planned progress.

## Release-gate journey

| Step                                       | Status | Evidence                                                                                                                      |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Start a local mock LLM                     | ✅     | `tokenfault mock`, `tokenfault proxy --mock`; `mock-llm.test.ts`; smoke test                                                  |
| Send a streaming request through the proxy | ✅     | `proxy.test.ts`; `openai-sdk.test.ts`; E2E                                                                                    |
| Inspect real SSE events                    | ✅     | Studio inspector (E2E); `tokenfault inspect` (smoke)                                                                          |
| Inject a failure                           | ✅     | Scenarios A–I via header, CLI, Studio; `mock-llm.test.ts`, `proxy.test.ts`, E2E                                               |
| Observe the exact failure                  | ✅     | Outcome, termination kind and fault annotations asserted in integration and E2E tests                                         |
| Record the session                         | ✅     | Studio export, `--record`, `--record-dir`; `recording-static.test.ts`, smoke, E2E                                             |
| Replay without contacting an AI API        | ✅     | In-Studio replay, `tokenfault replay` local and `--serve`; `recording-replay.test.ts`, `recording-static.test.ts`, smoke, E2E |

## Quality gates (latest local run)

| Gate                                               | Command                    | Result                                                                                                        |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Build                                              | `pnpm build`               | ✅ pass                                                                                                       |
| Typecheck (all packages, tests, E2E, tool configs) | `pnpm typecheck`           | ✅ pass                                                                                                       |
| Lint (type-aware, `--max-warnings=0`)              | `pnpm lint`                | ✅ pass                                                                                                       |
| Format                                             | `pnpm format:check`        | ✅ pass                                                                                                       |
| Unit tests                                         | `pnpm test:unit`           | ✅ 200 passed, 11 files                                                                                       |
| Integration + contract tests                       | `pnpm test:integration`    | ✅ 79 passed, 5 files                                                                                         |
| CLI smoke test (built binary)                      | `pnpm smoke`               | ✅ 34/34 checks                                                                                               |
| E2E (Playwright, Chromium)                         | `pnpm test:e2e`            | ✅ 3 passed                                                                                                   |
| GitHub Actions CI                                  | `.github/workflows/ci.yml` | ⚪ **Not run yet**: the workflow exists but has not run on GitHub (nothing pushed when this file was written) |
| macOS / Windows                                    | —                          | ⚪ **Not run**                                                                                                |
| Code coverage                                      | —                          | ⚪ **Not measured**: no coverage tooling configured; no percentage is claimed                                 |
| Performance benchmarks                             | —                          | ⚪ **Not measured**: no benchmark numbers are claimed                                                         |

### Test inventory

| File                                            | Tests | Focus                                                                                                                                     |
| ----------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/sse-decoder.test.ts`        |    39 | WHATWG rules, line endings, split UTF-8, invalid UTF-8, bounded memory, partition invariance (1-byte and 200 random partitions)           |
| `packages/core/test/sse-framer-encoder.test.ts` |     8 | Byte-exact framing, CRLF across chunks, encoder round-trip                                                                                |
| `packages/core/test/chat-stream.test.ts`        |    17 | Interpreter, accumulator, protocol violations, retention bounds                                                                           |
| `packages/core/test/stream-inspector.test.ts`   |    11 | Metrics, outcomes, capture limits, redaction                                                                                              |
| `packages/core/test/faults.test.ts`             |    41 | Schema validation, determinism, scenarios A–I planning, executor                                                                          |
| `packages/core/test/recording-replay.test.ts`   |    18 | Redaction skeletons, schema validation (malicious inputs), replay modes and timing                                                        |
| `packages/core/test/review-regressions.test.ts` |     7 | Review regressions: hostile recording data, replayability, long sleeps, `endResponse`                                                     |
| `packages/shared/test/redact.test.ts`           |    21 | Sensitive headers, query redaction, secret scrubbing                                                                                      |
| `packages/proxy/test/target-headers.test.ts`    |    27 | Target lock, traversal, header policy, request metadata                                                                                   |
| `packages/proxy/test/session-store.test.ts`     |     4 | Eviction, batching, subscriber isolation                                                                                                  |
| `packages/cli/test/cli.test.ts`                 |     7 | Terminal sanitisation, option parsing, entry point                                                                                        |
| `tests/integration/mock-llm.test.ts`            |    20 | Mock protocol and scenarios A–I observed by a real client                                                                                 |
| `tests/integration/proxy.test.ts`               |    35 | AC-2.1–2.9: streaming, headers, cancellation, resets, timeouts, backpressure, SSRF, DNS rebinding, control-plane guard, replay, live feed |
| `tests/integration/recording-static.test.ts`    |    12 | Recorder permissions and retention, replay server, static file traversal and symlinks                                                     |
| `tests/integration/openai-sdk.test.ts`          |     6 | Contract with the official `openai` SDK 5.23.2                                                                                            |
| `tests/integration/example-client.test.ts`      |     6 | Reference resilient client against the scenarios                                                                                          |
| `tests/e2e/studio.spec.ts`                      |     3 | Full Studio journey, Fault Lab, CSP and cross-site rejection                                                                              |

## Internal adversarial review (2026-10-09)

An independent review pass over the proxy, core streaming and recording code reported 8 defects and 3 minor
items, each with a reproduction script. All of them were fixed, and each fix has a regression test. The tests
for items 1, 2 and 5 were confirmed to fail on the pre-fix code.

| #   | Severity | Defect                                                                                                                                     | Fix                                                                                                      |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 1   | High     | Percent-encoded (`/%5F%5Ftokenfault/...`) and absolute-form request targets reached control routes while bypassing the control-plane guard | Guard uses the matched route and the decoded path; absolute-form targets are rejected (THREAT_MODEL T19) |
| 2   | Medium   | The idle timer ran while the proxy itself waited (injected stall or client backpressure) and blamed the upstream                           | Idle timer paused while writing (D-020)                                                                  |
| 3   | Medium   | Upstream values beyond recording bounds made export, replay and recording fail with 500                                                    | Fields clamped in `createRecording` (T20)                                                                |
| 4   | Medium   | `res.end(cb)` never calls back after a socket destroy, which could leave an exchange unterminated                                          | `endResponse()` resolves on finish or close                                                              |
| 5   | Low–Med  | The decoder's size limit depended on chunk boundaries for CRLF streams                                                                     | The LF after a CR is not counted towards the block size; fuzz test added                                 |
| 6   | Low      | Recordings that passed validation but could not be replayed (line breaks in `event`, NUL in `id`, bad base64, length mismatch)             | Schema refinements; replay errors map to 400                                                             |
| 7   | Low      | `sleep()` overflowed for delays above 2³¹−1 ms                                                                                             | Long waits are chained                                                                                   |
| 8   | Low      | Sessions evicted or cleared while streaming were never recorded                                                                            | End listeners always run                                                                                 |
| —   | Minor    | Wrong 504 message for the total timeout; annotation placement under fixed-timing chunk replays; unbounded `body` in the measuring client   | Fixed (`maxBodyBytes`, default 64 MiB)                                                                   |

## Completed features

All items under _Implemented_ in [ROADMAP.md](../../ROADMAP.md).

## Known defects and limitations

1. **Timing precision.** Metrics use `performance.now()` in the measuring process. Through the proxy, the Studio shows
   the timeline the **proxy** observed, so client-side network latency is not included.
2. **Capture budget accounting.** The per-session payload budget counts both raw chunk bytes and decoded event
   data, so the effective captured stream is about half of `maxCapturedBytesPerSession`. Metrics are unaffected.
3. **Fragmentation is best effort at the receiver.** Separate writes with a delay usually arrive as separate reads
   on loopback. TCP does not guarantee it.
4. **Event `endOffset` for CRLF streams.** The trailing LF of a CRLF blank line is not attributed to any event.
   This is deliberate, for chunk-invariance (DECISIONS D-004).
5. **No upstream `HTTP(S)_PROXY` support** (`doctor` warns about it).
6. **Studio** is dark-only and has not had a formal accessibility audit. Keyboard navigation exists for the
   event list, tabs and controls.

## Unfinished work

- Publishing (npm), release automation, signed artifacts
- CI on macOS/Windows, dependency audit, coverage reporting
- Responses API and Anthropic Messages adapters (not claimed as supported)
- Optional control-API token for multi-user machines

## Technical risks

| Risk                                                                      | Impact                                                           | Mitigation / next step                                                     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| CI has not run on GitHub yet                                              | Hidden environment differences (e.g. Playwright browser install) | Push the branch and watch the first run                                    |
| Toolchain majors moved on (TS 7, Vite 8, Vitest 5)                        | Future upgrade effort                                            | Versions pinned; upgrade deliberately (DECISIONS D-002)                    |
| Behaviour of other OpenAI-compatible servers (vLLM, Ollama, OpenRouter …) | Unknown keys or different terminators                            | The interpreter reports rather than fails; add fixtures from real captures |
| Fastify `hijack()` streaming relies on raw Node semantics                 | Fastify upgrades could change hook behaviour                     | Integration tests cover hijacked paths                                     |

## Next priorities

1. Push the branch, run CI, and fix any environment-specific failures.
2. Confirm the copyright holder in `LICENSE` (DECISIONS D-013).
3. Add macOS and Windows CI runners. Add a dependency audit.
4. Publish `tokenfault`, `@tokenfault/core` and `@tokenfault/testing` to npm (packages are currently `private`).
5. Add an optional control-API token. Then the Responses API adapter with contract tests.
