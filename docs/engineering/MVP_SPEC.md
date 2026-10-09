# MVP Specification and Acceptance Criteria

## Target user journey (release gate)

> Developer opens TokenFault → starts a local mock LLM → sends a streaming request through the
> TokenFault proxy → inspects real SSE events → injects a failure → observes the exact failure →
> records the session → replays the recorded stream, without contacting an external AI API.

Each step maps to acceptance criteria below. A step is **done** only when the referenced
automated test exists and passes.

## Scope

**In scope (v0.1).** OpenAI-compatible Chat Completions (`POST /v1/chat/completions`) over
SSE: streaming and non-streaming.

**Out of scope (v0.1).** OpenAI Responses API, Anthropic Messages API, WebSockets, HTTP/2
upstream, multi-user/team features, and persistence beyond local recording files.
These are not claimed anywhere.

## Acceptance criteria

### AC-1 Streaming core

| ID     | Criterion                                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1.1 | The decoder produces identical events for any partition of the same byte stream, including 1-byte chunks.                                             |
| AC-1.2 | Multi-byte UTF-8 characters split across chunks decode correctly. Invalid UTF-8 produces a diagnostic with an offset.                                 |
| AC-1.3 | LF, CR and CRLF line endings are supported, including a CR at the end of one chunk followed by LF in the next.                                        |
| AC-1.4 | Multi-line `data`, `event`, `id` (NULL-containing ids ignored), `retry` (digits only) and comments follow the WHATWG rules.                           |
| AC-1.5 | An unterminated event at EOF is not dispatched and is reported as `sse-truncated-event`.                                                              |
| AC-1.6 | An event larger than `maxEventBytes` is discarded with a diagnostic, and the decoder resynchronises at the next blank line. Memory stays bounded.     |
| AC-1.7 | The interpreter handles content, role, tool-call deltas, `finish_reason`, usage, error payloads and `[DONE]`. Unknown keys are reported, not dropped. |

### AC-2 Proxy

| ID     | Criterion                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| AC-2.1 | Responses are streamed. The first event reaches the client before the upstream finishes.                   |
| AC-2.2 | Upstream status codes and safe headers are preserved. Hop-by-hop headers are stripped.                     |
| AC-2.3 | A client disconnect aborts the upstream request.                                                           |
| AC-2.4 | An upstream reset mid-stream resets the client connection. It is never turned into a clean EOF.            |
| AC-2.5 | Unreachable upstream → 502. Headers timeout → 504. Idle timeout after headers → client connection reset.   |
| AC-2.6 | The target is fixed at startup. Absolute-form or `//host` request targets cannot change the upstream host. |
| AC-2.7 | `Authorization` and other sensitive headers never appear in logs, sessions or recordings.                  |
| AC-2.8 | The proxy binds to loopback by default. Non-loopback binding requires `--allow-remote`.                    |
| AC-2.9 | The control API rejects non-loopback peers, non-loopback `Host` headers and cross-site writes.             |

### AC-3 Fault injection (scenarios A–I)

Each scenario has a schema, input validation, deterministic behaviour under a fixed seed, and a
test proving the observable effect on the client.

### AC-4 Mock LLM

`POST /v1/chat/completions` with streaming and non-streaming responses. Output is deterministic
for a given request. Tool calls are supported, and all fault scenarios can be selected per
request. No API key or network access is needed.

### AC-5 Recording and replay

A recording validates against its schema version. Payload content is excluded unless explicitly
enabled. Replay reproduces the event order with original, scaled or fixed timing. Malformed or
oversized recordings are rejected with a clear error.

### AC-6 CLI

`doctor`, `mock`, `proxy`, `inspect`, `scenarios` and `replay` work as documented in `--help`.
They return non-zero exit codes on failure, support `--json` output where documented, and shut
down gracefully on SIGINT/SIGTERM.

### AC-7 Studio

The Studio shows live sessions, an event timeline, event details (raw + parsed), Fault Lab,
recording export and replay. It never shows fabricated data. Empty states offer to run a mock
request.

### AC-8 Quality gates

Build, typecheck, lint, format, unit, integration, CLI smoke and (where the environment allows)
Playwright E2E all pass in CI.
