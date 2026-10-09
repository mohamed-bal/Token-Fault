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
