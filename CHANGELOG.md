# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/) once published.

## [Unreleased]

### Added

- Initial implementation of TokenFault 0.1.0 (not yet released or published):
  - `@tokenfault/core`: SSE decoder/framer/encoder, OpenAI chat-completions interpreter, stream inspector,
    deterministic fault engine (scenarios A–I), recording format v1 and replay
  - `@tokenfault/mock-llm`: deterministic OpenAI-compatible mock server
  - `@tokenfault/proxy`: streaming proxy, session store, loopback-only control API, live feed, recorder,
    replay manager and replay server, Studio host
  - `@tokenfault/testing`: in-process stacks, measuring client, control client
  - `tokenfault` CLI: `proxy`, `mock`, `inspect`, `scenarios`, `replay`, `doctor`
  - TokenFault Studio web UI
  - Unit, integration, OpenAI SDK contract, CLI smoke and Playwright E2E test suites; GitHub Actions CI
- Control-plane authentication, on by default: a per-run control token (`Authorization: Bearer`) for tools and a
  Studio sign-in that uses an `HttpOnly`, `SameSite=Strict` session cookie. `TOKENFAULT_CONTROL_TOKEN` supplies a
  fixed token; `--no-control-auth` disables it. `@tokenfault/testing` passes the token automatically.
- Publishable packages: `tokenfault` (CLI with the Studio bundled), `@tokenfault/core`, `@tokenfault/testing` and
  their runtime dependencies `@tokenfault/shared`, `@tokenfault/mock-llm`, `@tokenfault/proxy`; an external
  install test (`scripts/pack-test.mjs`) in CI. Nothing has been published.
- CI on Linux, Windows and macOS (Node 22) and Linux (Node 24); `pnpm audit` job; actions pinned by commit SHA
- Benchmark suite (`pnpm bench`) and documented results (`docs/engineering/BENCHMARKS.md`)

### Fixed

- A `101 Switching Protocols` reply from the upstream left the exchange hanging; it now fails with 502
- Upstream HTML could run script in the Studio's origin; forwarded responses now carry a sandbox CSP and `nosniff`,
  and cross-site navigations to the data path are refused
- Raw URLs (with query values) in Fastify's default 404 and URL-parse errors; bare query parameters were not redacted
- The mock echoed unbounded schema values into tool arguments (memory amplification)
- Studio paths were percent-decoded twice
- SSE decoder was quadratic in chunk size (3–5× slower on 64–256 KiB reads)
- `--json` output could be truncated on exit through a pipe; reset terminations could drop unsent bytes on Windows
- `inspect --record` to an existing file sent the request first and then failed with a raw `EEXIST`
- An unrelated `apps/studio/dist` next to an installed CLI could be served as the Studio

### Security

- See `docs/engineering/PHASE2_AUDIT.md` and the threat model (T21–T26). Internal review only; no external audit.
