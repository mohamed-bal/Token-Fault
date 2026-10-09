# Release Audit: 0.1.0

- **Date:** 2026-10-09
- **Starting revision:** `2133883` (`main`)
- **Scope:** an internal pre-release validation by the maintainers' tooling, covering CI, an external-consumer
  install, the first-time user journey, security, packaging, performance and documentation. It is **not** an
  independent external audit.

## Starting state (verified, not carried over)

| Item                             | Result                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| CI run #3 (`867b95e`)            | 6/6 jobs passed                                                                          |
| CI run #4 (`2133883`, docs-only) | **Failed**: Windows, 1 integration test (`replay server … without contacting any model`) |
| Conclusion                       | A test that is flaky on Windows; the green run #3 alone did not prove Windows stability  |

## Findings

| ID     | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                     | Fix                                                                                                                                                        |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XP-10  | High     | A fault or replayed TCP reset could be delayed by up to 1 s. `terminateResponse('reset')` waited for `'drain'` while bytes were queued, but `'drain'` only follows a `write()` that returned `false`. With a few bytes queued below the high-water mark (typical on Windows), the RST waited for the 1 s fallback. This distorts fault timing and made a CI test fail intermittently on Windows. | CI run #4 log: `expected 1019.141 to be less than 131.0795`. Reproduced on Linux with emulated 15.6 ms timers: `writableLength=509 needDrain=false`, RST 1015 ms later. `packages/core/src/node/response.ts` | Wait for the callback of an empty `write()` (runs after all queued data is flushed); keep the 1 s fallback. Regression test fails on the old code.         |
| XP-9b  | Medium   | Regression from the XP-9 fix (`867b95e`): `WaitPacer` subtracted earlier timer overshoot from **every** fault wait, so a jitter gap could fall below its configured `minGapMs`. Stalls and delays were affected in the same way.                                                                                                                                                                 | Regression test: a 20 ms jitter wait after one paced 1 ms gap took 6.6 ms. The jitter integration test failed 3/3 under emulated Windows timers. `packages/core/src/faults/executor.ts`                      | Pacing only for fragmentation gaps (an average-rate contract). Jitter, stalls, delays and the mock's event interval are slept in full and reset the pacer. |
| REL-1  | Low      | `createTokenFaultServer()` reported a hardcoded `'0.1.0'` when no version was passed, which would drift on the next release.                                                                                                                                                                                                                                                                     | `packages/proxy/src/server.ts`                                                                                                                                                                               | Read the version from the package manifest; integration test compares it with `package.json`.                                                              |
| CI-1   | Low      | Pinned actions (checkout v4, setup-node v4, pnpm/action-setup v4, upload-artifact v4) declare `using: node20`; GitHub forces them onto Node 24 and warns. They will stop working when the runtime is removed. Not a vulnerability.                                                                                                                                                               | Run logs: "Node.js 20 is deprecated …". `action.yml` of each pinned SHA.                                                                                                                                     | Pinned to checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.0, upload-artifact v7.0.2 (`using: node24`); inputs used are unchanged.               |
| DOC-4  | Low      | `IMPLEMENTATION_STATUS.md` still listed "Windows/macOS CI has not run yet" as a technical risk, and claimed Windows passed without mentioning the flaky run #4.                                                                                                                                                                                                                                  | `docs/engineering/IMPLEMENTATION_STATUS.md:131`                                                                                                                                                              | Corrected; platform table records runs #3, #4 and the fixing run.                                                                                          |
| PROC-1 | Info     | Process error: during XP-9 the XP-10 failure was reproduced under timer emulation and dismissed as an emulation artifact because real Windows had passed once. Run #4 proved it real.                                                                                                                                                                                                            | This document                                                                                                                                                                                                | Emulated-timer runs are now treated as evidence; the whole integration suite passes 3/3 under emulation.                                                   |

## Security review (internal)

Reproduced against local loopback servers with synthetic secrets only; scripts were run against the built packages.
No Critical, High or Medium findings. All Low findings except SEC-R6 are fixed with regression tests that fail on
the previous code (commit `ac80606`).

| ID     | Severity | Finding                                                                                                                                      | Status                                                                                                                                      |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-R1 | Low      | The live feed kept streaming captured completions after logout (authorization was only checked when the stream opened)                       | Fixed: authorization re-checked before every write; security headers added to the feed                                                      |
| SEC-R2 | Low      | Ten wrong sign-ins per minute from any local process blocked the correct token too (one global failure bucket checked before the comparison) | Fixed: a correct token always signs in; only wrong guesses are throttled                                                                    |
| SEC-R3 | Low      | A `tf_session` cookie planted by another 127.0.0.1 page or by an upstream `Set-Cookie` shadowed the real session (first cookie value won)    | Fixed: every value checked; upstream cookies named `tf_session` or scoped to `/__tokenfault` dropped                                        |
| SEC-R4 | Low      | `tokenfault replay --serve` had no loopback `Host` check (DNS rebinding could read a payload recording)                                      | Fixed: loopback `Host` required unless `--allow-remote`                                                                                     |
| SEC-R5 | Low      | `requestTimeout: 0`: unfinished request bodies held sockets and up to 20 MiB each forever (40 connections → 835 MiB RSS)                     | Fixed: 120 s to receive a request; streamed responses are unaffected                                                                        |
| SEC-R6 | Low      | Four imported recordings declaring very long durations (up to the 30-day schema bound) occupy all replay slots until the proxy restarts      | **Open, accepted residual risk** (THREAT_MODEL residual risk 10): fixing it needs a new cancel route; impact is limited to in-Studio replay |
| SEC-I1 | Info     | A 413 on `POST /replays` reports the general 20 MiB limit, while that route allows 32 MiB                                                    | Open (cosmetic)                                                                                                                             |

Held under test: token entropy (256-bit) and flat comparison timing; Bearer parsing and query-token rejection;
path, encoding and method bypasses of the control plane; cookie attributes, logout and 12 h expiry; CSRF (Origin,
`Sec-Fetch-Site`, content type, preflight), including from a real Chromium page; SSRF and target lock; request
smuggling variants; hop-by-hop and `x-tokenfault-*` stripping; DNS rebinding on the data path; a 300 MiB SSE event
(bounded memory); cancellation; redaction in logs, sessions, the live feed and recordings; hostile recordings
(`__proto__`, deep nesting, bad base64, oversized); replays never contacting an upstream; Studio CSP and the absence
of the token in the bundle.

## Packaging review

All six names (`tokenfault`, `@tokenfault/{core,testing,shared,proxy,mock-llm}`) return E404 on the public registry,
and `npm org ls tokenfault` returns "Scope not found". Ownership cannot be confirmed without the maintainer's npm
login, so it is a maintainer action in the release checklist. Tarball checks: no local absolute paths, every
`workspace:*` rewritten to `0.1.0`, `bin.js` executable with a shebang, every source map and `.d.ts` reference
resolves, LICENSE identical in all six, and `pnpm publish --dry-run` (pointed at an unreachable registry) packs the
same files as `pnpm pack`. Info: `tokenfault`'s library typings reference `@types/node` types (`util`), which only
matters for TypeScript users importing the CLI's library entry.

## External consumer validation (outside the monorepo)

All six packages were packed with `pnpm pack` and installed with `npm` from the tarballs only into an empty project
in a temporary directory (`file:` dependencies plus `overrides`; no workspace links).

| Test                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — clean installation | 58 packages installed; no `@tokenfault/studio` dependency; `pnpm test:pack` 57/57 checks (contents, LICENSE identical to the root, source maps resolve, no `workspace:` left, Studio and `THIRD_PARTY_LICENSES.txt` bundled, `dist/bin.js` mode `-rwxr-xr-x` with a shebang)                                                                                                                                                                                                |
| B — first-time journey | 14/14 steps from the installed CLI: version, `doctor` (Studio found), `tokenfault mock`, `tokenfault proxy --target`, Studio sign-in in Chromium with the printed token (not found in browser storage), streaming request with real SSE events, `mid-stream-disconnect` shown as an injected `fault-disconnect`, `inspect --record`, graceful SIGINT shutdown (exit 0, ports released), `replay` reproducing the incomplete stream with the mock stopped, no processes left |
| C — public SDK imports | A strict TypeScript app (`skipLibCheck: false`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, NodeNext) using `@tokenfault/core` (decoder, interpreter, recording, replay plan) and `@tokenfault/testing` (stack, client, control API) compiles with `tsc` and runs                                                                                                                                                                                             |

## Performance regression check

Same machine and method as [BENCHMARKS.md](BENCHMARKS.md) (Linux x64, 4 vCPU, Node 22.22.0, shared VM, about ±15%
noise between runs):

| Benchmark                              | BENCHMARKS.md | This audit |
| -------------------------------------- | ------------- | ---------- |
| Decoder, 64 KiB chunks (`decoder-ab`)  | 377–422 ms    | 365 ms     |
| Decoder, 256 KiB chunks (`decoder-ab`) | 256 ms        | 257 ms     |
| Decoder, 16 KiB chunks (suite)         | 361 ms        | 359 ms     |
| Inspector, capture on                  | 372 ms        | 370 ms     |
| Proxy throughput, capture on           | 26.1 MiB/s    | 24.6 MiB/s |
| Proxy first byte (median)              | 17.6 ms       | 18.3 ms    |
| Server heap after 20 more streams      | 170.9 MiB     | 170.9 MiB  |

No regression beyond the VM's noise. PERF-1 (quadratic decoding) has not returned: decoding time is flat from
64 B to 256 KiB chunks (the pre-fix decoder took 1,368 ms at 256 KiB).
