# Implementation Status

- **Last updated:** 2026-10-09
- **Version:** 0.1.0 (unreleased, not published)
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

## Quality gates

Local results are from the Linux environment of record above. GitHub results are quoted from GitHub Actions; a
platform without a GitHub result is **not verified**.

| Gate                                               | Command                 | Result (local, Linux)                                   |
| -------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Build                                              | `pnpm build`            | ✅ pass                                                 |
| Typecheck (all packages, tests, E2E, tool configs) | `pnpm typecheck`        | ✅ pass                                                 |
| Lint (type-aware, `--max-warnings=0`)              | `pnpm lint`             | ✅ pass                                                 |
| Format                                             | `pnpm format:check`     | ✅ pass                                                 |
| Unit tests                                         | `pnpm test:unit`        | ✅ 206 passed, 12 files                                 |
| Integration + contract tests                       | `pnpm test:integration` | ✅ 96 passed, 7 files                                   |
| CLI smoke test (built binary)                      | `pnpm smoke`            | ✅ 36/36 checks                                         |
| E2E incl. accessibility (Playwright, Chromium)     | `pnpm test:e2e`         | ✅ 6 passed (axe-core WCAG 2.2 AA rules on every view)  |
| External install from packed tarballs              | `pnpm test:pack`        | ✅ 57/57 checks                                         |
| Dependency audit                                   | `pnpm audit`            | ✅ 0 known advisories (all and production dependencies) |
| Benchmarks                                         | `pnpm bench`            | Measured, not a gate: [BENCHMARKS.md](BENCHMARKS.md)    |
| Code coverage                                      | —                       | ⚪ Not measured; no percentage is claimed               |

| Platform (GitHub Actions) | Result                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux, Node 22            | ✅ Run #1 ([37934154330](https://github.com/mohamed-bal/Token-Fault/actions/runs/37934154330)) passed on `6fe5140` (`verify` and `e2e`). Later commits: not run yet. |
| Windows, Node 22          | ⚪ Not verified: the matrix job exists in `ci.yml` but has not run on GitHub                                                                                         |
| macOS, Node 22            | ⚪ Not verified: as above                                                                                                                                            |
| Linux, Node 24            | ⚪ Not verified: as above                                                                                                                                            |

### Test inventory

| File                                            | Tests | Focus                                                                                                                                                          |
| ----------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/sse-decoder.test.ts`        |    39 | WHATWG rules, line endings, split UTF-8, invalid UTF-8, bounded memory, partition invariance (1-byte and 200 random partitions), CRLF size limits              |
| `packages/core/test/sse-framer-encoder.test.ts` |     8 | Byte-exact framing, CRLF across chunks, encoder round-trip                                                                                                     |
| `packages/core/test/chat-stream.test.ts`        |    17 | Interpreter, accumulator, protocol violations, retention bounds                                                                                                |
| `packages/core/test/stream-inspector.test.ts`   |    12 | Metrics, outcomes, capture limits, redaction, native/portable base64 equivalence                                                                               |
| `packages/core/test/faults.test.ts`             |    41 | Schema validation, determinism, scenarios A–I planning, executor                                                                                               |
| `packages/core/test/recording-replay.test.ts`   |    18 | Redaction skeletons, schema validation (malicious inputs), replay modes and timing                                                                             |
| `packages/core/test/review-regressions.test.ts` |     7 | Review regressions: hostile recording data, replayability, long sleeps, `endResponse`                                                                          |
| `packages/shared/test/redact.test.ts`           |    22 | Sensitive headers, query redaction (including bare parameters), secret scrubbing                                                                               |
| `packages/proxy/test/target-headers.test.ts`    |    27 | Target lock, traversal, header policy (including isolation headers), request metadata                                                                          |
| `packages/proxy/test/session-store.test.ts`     |     4 | Eviction, batching, subscriber isolation                                                                                                                       |
| `packages/cli/test/cli.test.ts`                 |     7 | Terminal sanitisation, option parsing, entry point                                                                                                             |
| `packages/cli/test/meta.test.ts`                |     4 | Studio asset discovery (bundled, monorepo, env, unrelated `apps/studio` never served)                                                                          |
| `tests/integration/mock-llm.test.ts`            |    20 | Mock protocol and scenarios A–I observed by a real client                                                                                                      |
| `tests/integration/proxy.test.ts`               |    36 | AC-2.1–2.9: streaming, headers, cancellation, resets, timeouts, backpressure, SSRF, DNS rebinding, control-plane guard, replay, live feed, event-loop fairness |
| `tests/integration/control-auth.test.ts`        |     9 | Control token: 401s, Bearer, cookie attributes, logout, Origin guard, rate limit, disabled mode, token never logged                                            |
| `tests/integration/security-p2.test.ts`         |     7 | Phase 2 security regressions SEC-1 to SEC-7                                                                                                                    |
| `tests/integration/recording-static.test.ts`    |    12 | Recorder permissions and retention, replay server, static file traversal and symlinks (symlink case skipped where the OS forbids them)                         |
| `tests/integration/openai-sdk.test.ts`          |     6 | Contract with the official `openai` SDK 5.23.2                                                                                                                 |
| `tests/integration/example-client.test.ts`      |     6 | Reference resilient client against the scenarios                                                                                                               |
| `tests/e2e/studio.spec.ts`                      |     4 | Sign-in and token storage, full Studio journey, Fault Lab, CSP and cross-site rejection                                                                        |
| `tests/e2e/accessibility.spec.ts`               |     2 | axe-core WCAG 2.2 AA on sign-in, Overview, Inspector (normal and faulted), Fault Lab, Replay; keyboard operation of list and tabs                              |

## Phase 2 audit (2026-10-09)

Findings, fixes and regression tests: [PHASE2_AUDIT.md](PHASE2_AUDIT.md). Summary: 8 security/privacy findings
(SEC-1 to SEC-8, highest Medium), 2 performance defects, 6 packaging defects (PKG-1 High: the packages could not be
installed outside the monorepo), 8 cross-platform issues and 3 documentation inaccuracies. All are fixed except
XP-8 (POSIX file modes on Windows), which is documented. The Studio accessibility and terminology review fixes are
in commit `83e1383`.

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
6. **Studio** is dark-only. Automated axe-core checks (WCAG 2.2 AA rules) and keyboard tests pass, but there has
   been no manual screen-reader audit; automated checks catch only part of WCAG.
7. **Windows file permissions.** Recording files are not restricted to the current user on Windows (XP-8).
8. **Control token in the terminal.** The token is printed once on start; anyone who can see that terminal can use
   the control API.

## Unfinished work

- First npm publication and GitHub release (release-ready, waiting for approval; see [RELEASE.md](RELEASE.md))
- CI results for Windows, macOS and Node 24 (configured, not run yet)
- Coverage reporting; E2E on Windows and macOS
- Responses API and Anthropic Messages adapters (not claimed as supported)

## Technical risks

| Risk                                                                      | Impact                                                         | Mitigation / next step                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Windows/macOS CI has not run yet                                          | Platform differences in signals, file modes, paths and sockets | Push and watch the matrix; fixes for known issues (XP-1..7) are in place   |
| Toolchain majors moved on (TS 7, Vite 8, Vitest 5)                        | Future upgrade effort                                          | Versions pinned; upgrade deliberately (DECISIONS D-002)                    |
| Behaviour of other OpenAI-compatible servers (vLLM, Ollama, OpenRouter …) | Unknown keys or different terminators                          | The interpreter reports rather than fails; add fixtures from real captures |
| Fastify `hijack()` streaming relies on raw Node semantics                 | Fastify upgrades could change hook behaviour                   | Integration tests cover hijacked paths                                     |

## Next priorities

1. Push (with approval) and get the Windows, macOS and Node 24 CI results; fix any platform failures.
2. Delete the obsolete remote branch `ccr-c63d96e2-537cz5` (GIT-1, manual).
3. Apply the repository metadata proposed in [RELEASE.md](RELEASE.md) (manual).
4. First release 0.1.0 following [RELEASE.md](RELEASE.md), once every gate passes and the maintainer approves.
5. Responses API adapter with contract tests.
