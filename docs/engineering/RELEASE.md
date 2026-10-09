# Release Engineering

How TokenFault is versioned, packaged and released, and what must be true before the first release.
**Nothing has been published.** Publishing to npm and creating GitHub releases need the maintainer's explicit
approval; no automation in this repository publishes anything.

## Packages and dependency graph

| Package                | Published | Role                                                            |
| ---------------------- | --------- | --------------------------------------------------------------- |
| `tokenfault`           | yes       | CLI (`tokenfault` binary); ships the built Studio in `studio/`  |
| `@tokenfault/core`     | yes       | Public SDK: SSE decoder, interpreter, faults, recording, replay |
| `@tokenfault/testing`  | yes       | Public SDK: in-process mock + proxy stacks for test suites      |
| `@tokenfault/proxy`    | yes       | Runtime dependency of `tokenfault` and `@tokenfault/testing`    |
| `@tokenfault/mock-llm` | yes       | Runtime dependency of `tokenfault` and `@tokenfault/testing`    |
| `@tokenfault/shared`   | yes       | Runtime dependency of every package (types, limits, redaction)  |
| `@tokenfault/studio`   | **no**    | Private build input; its `dist/` is copied into `tokenfault`    |

```text
tokenfault ──► proxy ──► core ──► shared
    │   └────► mock-llm ─┘
    └──(build only)── studio
@tokenfault/testing ──► proxy, mock-llm, core, shared
```

Bundling `proxy`, `mock-llm` and `shared` into the CLI was considered: it would hide three packages from users,
but `@tokenfault/testing` needs the same code as real dependencies (types flow through its public API), so
bundling would ship two copies. Publishing all six in lockstep keeps one copy and one version.

Third-party runtime dependencies: `fastify` (pinned) and `zod` (caret, major 4). The Studio bundle contains React,
ReactDOM, scheduler and Tailwind CSS output; their licenses ship in `studio/THIRD_PARTY_LICENSES.txt`.

## Versioning

- **Lockstep:** all six published packages always carry the same version, and internal dependencies are exact
  (`workspace:*` is rewritten to the exact version by `pnpm pack`/`pnpm publish`).
- **SemVer, 0.x rules:** while `0.y.z`, a minor bump (`0.y`) may break the CLI contract, the public API, the
  recording format or the control API; a patch bump (`0.y.z`) must not. Breaking changes are listed under a
  **Breaking** heading in the changelog.
- **What counts as the contract:** CLI commands, flags and exit codes; the exports of `@tokenfault/core`,
  `@tokenfault/testing` and `@tokenfault/proxy`; the recording format (`schemaVersion`); the control API routes;
  the `x-tokenfault-*` request headers.
- **Recording format:** `schemaVersion` changes only with an incompatible format change. Readers keep accepting
  every earlier `schemaVersion` they ever accepted, or fail with a clear message.
- **First release:** `0.1.0`. It was never published before, so the control-token default (D-021) breaks no
  released consumer.

## Release procedure (manual)

1. On a clean checkout of `main` with CI green on all jobs (Linux, Windows, macOS, E2E, audit):
   `pnpm install --frozen-lockfile && pnpm verify && pnpm test:pack`.
2. Set the version in all six package manifests (and the root and Studio manifests) in one commit; move the
   changelog's `Unreleased` section under the version and date.
3. Tag `vX.Y.Z` on that commit.
4. Publish in dependency order: `shared`, `core`, `mock-llm`, `proxy`, `testing`, `tokenfault`, each with
   `pnpm publish --access public` from its package directory (pnpm rewrites `workspace:*`). Prefer npm
   provenance (`--provenance`) from CI once a publishing workflow has been reviewed.
5. Smoke-test from the registry in an empty directory: `npx tokenfault@X.Y.Z doctor` and
   `npx tokenfault@X.Y.Z inspect --mock`.
6. Create the GitHub release from the tag, with the changelog section as notes.

## Rollback and deprecation

- npm versions are immutable and `npm unpublish` is limited to 72 hours and breaks dependents, so a broken
  release is **not** unpublished. Instead: `npm deprecate <pkg>@X.Y.Z "<reason>; use X.Y.Z+1"` on every affected
  package, and publish a fixed patch release of all six packages (lockstep).
- If the `latest` dist-tag points at a broken version and no fix is ready, move it back:
  `npm dist-tag add <pkg>@<previous> latest` for each package.
- A security fix is released as a patch and announced through a GitHub security advisory.
- Removed CLI flags or exports are deprecated for at least one minor version (warning on use) before removal,
  except when the old behaviour is itself a security problem.

## Release notes (draft for 0.1.0)

> **TokenFault 0.1.0: first public release.** Inspect, replay, break and harden AI streaming applications.
>
> - Streaming proxy for OpenAI-compatible Chat Completions with byte-level SSE inspection and measured metrics
>   (SSE events and deltas, never "tokens")
> - Nine deterministic fault scenarios (rate limits, 503, slow first byte, stalls, mid-stream disconnects,
>   fragmented and malformed SSE, broken tool calls, missing terminator)
> - Recording and byte-exact replay with no model contacted; payload-free recordings by default
> - Local Studio UI, protected by a per-run control token
> - `@tokenfault/testing` for test suites; `@tokenfault/core` for SSE decoding and replay in your own tools
> - Tested on Linux, Windows and macOS in CI (Node 22; Linux also Node 24)
>
> Not supported yet: OpenAI Responses API, Anthropic Messages API, WebSockets, HTTP/2 upstreams.
> TokenFault has had internal reviews only, no external security audit.

The "tested on Windows and macOS" line may only stay if those CI jobs pass on the release commit (they pass on `867b95e`).

## Repository metadata (proposal; apply manually)

These values are not set by this repository's code. Apply them in GitHub under **Settings → General** (description,
website) and the **About** gear on the repository page (topics).

- **Description** (≤ 350 characters):
  `Debug, fault-inject and replay AI streaming (SSE) apps. A local proxy, mock LLM and Studio for OpenAI-compatible APIs: inspect every event, inject deterministic failures, record and replay them.`
- **Topics** (GitHub allows up to 20, lowercase, hyphens, ≤ 50 characters each):
  `llm`, `streaming`, `sse`, `server-sent-events`, `developer-tools`, `debugging`, `fault-injection`,
  `chaos-engineering`, `observability`, `typescript`, `openai-api`, `testing`, `proxy`, `replay`, `mock-server`
- **Website:** leave empty until there is a docs site or an npm page (no placeholder links).
- **Social preview:** `docs/assets/studio-inspector.png` is a real screenshot; GitHub recommends 1280×640.
- **Releases:** none yet. Do not create one before the gates below pass and the maintainer approves.

## Release readiness gates

Evaluated on 2026-10-09 against `867b95e` on `main`. `NOT VERIFIED`
means there is no evidence yet; it is not a pass.

| Gate                   | Criteria                                                                                       | Status                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Correctness        | Core, integration, contract and E2E tests pass                                                 | **PASS**: CI run #3 on `867b95e` (Linux, Windows, macOS; E2E on Linux); locally 210 unit, 96 integration/contract, 6 E2E, 36 smoke checks                                  |
| B — Packaging          | Tarballs validated; external install works; exports and types resolve; runtime deps present    | **PASS**: `pnpm test:pack` (57 checks) green in CI on Linux, Windows and macOS                                                                                             |
| C — Security           | No unmitigated Critical/High findings; sensitive-data tests pass; dependency findings reviewed | **PASS**: no open Critical/High; redaction and token-leak tests pass; `pnpm audit` 0 advisories. Internal review only                                                      |
| D — Compatibility      | Linux CI verified; Windows and macOS CI verified when run                                      | **PASS**: CI run #3 ([37955049281](https://github.com/mohamed-bal/Token-Fault/actions/runs/37955049281)) on `867b95e`: Linux (Node 22 and 24), Windows and macOS (Node 22) |
| E — Documentation      | Quickstart verified; protocols documented accurately; limitations stated; license reviewed     | **PASS**: README journey replayed from a clean clone (Linux); MIT, holder `mohamed-bal` (D-013), Studio third-party notices shipped                                        |
| F — Release operations | Versioning defined; graph publishable; release notes; rollback documented                      | **PASS** (this document); publishing itself not exercised                                                                                                                  |

All six gates pass on `867b95e`. The release itself (npm publication, tag, GitHub release) still needs the
maintainer's approval, and gates must be re-checked on the release commit.
