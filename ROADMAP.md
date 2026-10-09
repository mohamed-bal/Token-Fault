# Roadmap

Status legend: **Implemented** (shipped and tested) · **In progress** · **Planned** · **Experimental**.

## Implemented (v0.1.0)

- Byte-level incremental SSE decoder, byte-exact framer and encoder
- OpenAI-compatible Chat Completions stream interpreter and accumulator (content, roles, tool calls, finish reasons, usage, in-stream errors, `[DONE]`)
- Stream inspector with measured metrics and bounded capture
- Deterministic fault engine: 9 fault types and scenarios A–I
- Streaming proxy with target lock, backpressure, cancellation, timeouts and honest failure propagation
- Mock LLM server (streaming, non-streaming, tool calls, per-request faults)
- Recording format v1 (validated, payload-free by default), local/in-Studio/HTTP replay
- Studio: overview, live inspector, event details, network chunks, response, diagnostics, Fault Lab, Replay
- CLI: `proxy`, `mock`, `inspect`, `scenarios`, `replay`, `doctor`
- `@tokenfault/testing` helpers and a reference resilient client example
- Contract tests against the official `openai` Node SDK 5.x

## Planned

- **Publishing:** npm packages for `tokenfault` (CLI), `@tokenfault/core` and `@tokenfault/testing`; signed release process
- **CI coverage:** macOS and Windows runners; dependency audit; coverage reporting
- **Protocols:** OpenAI Responses API adapter (with contract tests), then Anthropic Messages API adapter
- **Control-plane token:** optional per-run token for multi-user machines
- **Faults:** time-windowed faults (fault every N-th request, probability with seed), upstream-error passthrough injection, header delays per event
- **Recordings:** streaming (NDJSON) format for very long sessions; recording diff between two runs
- **Studio:** side-by-side session comparison; filtering events by kind; persisted UI preferences
- **Proxy:** optional `HTTP(S)_PROXY` support for upstream connections; HTTP/2 upstream

## Experimental

- None at the moment. Experimental features will be flagged in `--help` and the README before they ship.

## Not planned

- Acting as a production LLM gateway, router, cache or key vault
- Storing API keys or prompts
