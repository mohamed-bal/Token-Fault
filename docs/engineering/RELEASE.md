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

## Compatibility matrix (0.1.0)

| Platform              | Node.js | Status                                                                                                    |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| Linux (ubuntu-latest) | 22      | Verified in CI: build, typecheck, lint, unit, integration, CLI smoke, external install, Studio E2E + a11y |
| Linux (ubuntu-latest) | 24      | Verified in CI (same steps, without E2E)                                                                  |
| Windows (latest)      | 22      | Verified in CI (same steps, without E2E). Recording files are not restricted to the current user (XP-8)   |
| macOS (latest)        | 22      | Verified in CI (same steps, without E2E)                                                                  |
| Any                   | < 22.12 | Unsupported (`engines` requires ≥ 22.12)                                                                  |
| Studio browsers       | —       | Verified with Chromium (Playwright). Firefox and Safari are not tested                                    |

Protocols: OpenAI-compatible Chat Completions (streaming and non-streaming) and generic SSE are supported. The
OpenAI Responses API, the Anthropic Messages API, WebSockets and HTTP/2 upstreams are not.

## npm names and access

| Name                                                         | Registry (2026-10-09)                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `tokenfault`                                                 | Not published (`npm view` → E404)                                   |
| `@tokenfault/core`, `testing`, `shared`, `proxy`, `mock-llm` | Not published (E404)                                                |
| `@tokenfault` scope                                          | No organization found (`npm org ls tokenfault` → "Scope not found") |

A free name is not a publishing right. **Before the first publish the maintainer must** log in to npm, create
the `tokenfault` organization (which owns the `@tokenfault` scope) or confirm ownership, and check that
`tokenfault` can be published from that account. This cannot be verified without the maintainer's credentials.

## Release checklist (manual; nothing here is automated)

**Before tagging**

- [ ] `main` is green on the release commit for every CI job (Linux Node 22/24, Windows, macOS, E2E, audit).
- [ ] Clean checkout: `git clone … && pnpm install --frozen-lockfile && pnpm verify && pnpm test:pack`.
- [ ] `pnpm audit --prod` and `pnpm audit` report no unreviewed advisories.
- [ ] Version is the same in the root, `apps/studio` and all six package manifests (`0.1.0`);
      `node packages/cli/dist/bin.js --version` prints it.
- [ ] `CHANGELOG.md`: move `Unreleased` under `[0.1.0] - <date>`.
- [ ] npm organization and access confirmed (see above); 2FA enabled on the publishing account.

**Publish (maintainer only)**

1. Tag: `git tag -a v0.1.0 -m "TokenFault 0.1.0" && git push origin v0.1.0`.
2. From a clean build of the tagged commit, publish in dependency order. Each command runs from the package
   directory, and pnpm rewrites `workspace:*` to `0.1.0`:

   ```bash
   for p in shared core mock-llm proxy testing cli; do
     (cd packages/$p && pnpm publish --access public --no-git-checks)   # add --provenance from CI
   done
   ```

3. Create the GitHub release from the tag, with the release notes below.

**After publishing (empty directory, real registry)**

```bash
npm view tokenfault@0.1.0 version && npm view @tokenfault/core@0.1.0 dependencies
npx -y tokenfault@0.1.0 --version
npx -y tokenfault@0.1.0 doctor
npx -y tokenfault@0.1.0 inspect --mock --scenario mid-stream-disconnect   # expect exit code 3
mkdir sdk && cd sdk && npm init -y && npm i @tokenfault/testing@0.1.0 @tokenfault/core@0.1.0 \
  && node --input-type=module -e "import {startStack,streamChatCompletion} from '@tokenfault/testing'; const s=await startStack(); console.log((await streamChatCompletion(s.proxy.url)).snapshot.outcome); await s.close()"
```

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

> **TokenFault 0.1.0** — the first public release of a local toolkit to inspect, replay and fault-test
> streaming (SSE) AI applications that use OpenAI-compatible Chat Completions APIs.
>
> **What's included**
>
> - `tokenfault` CLI: `proxy`, `mock`, `inspect`, `scenarios`, `replay`, `doctor`, plus a local Studio web UI.
> - A streaming proxy locked to one upstream that decodes SSE byte by byte and measures timing (headers, first
>   byte, first event, first delta, gaps). Counts are SSE events and deltas, not model tokens.
> - Nine deterministic, seeded fault scenarios: slow first response, mid-stream disconnect, 429, 503, stall,
>   irregular timing, fragmented SSE, malformed data and fragmented tool calls.
> - Recording (payload-free by default) and replay that never contacts a model: byte-exact or event-level, with
>   original, scaled or fixed timing.
> - `@tokenfault/testing` to run the mock and proxy in-process in test suites; `@tokenfault/core` for SSE
>   decoding, chat-stream interpretation, recording and replay in your own tools.
>
> **Security defaults:** loopback-only binding, a per-run control token for the Studio and control API
> (HttpOnly session cookie for the browser), redaction of credentials and query values, and sandboxed forwarded
> content. Reviewed internally only; there has been no external security audit.
>
> **Tested on:** Linux (Node 22 and 24), Windows and macOS (Node 22) in CI; the Studio with Chromium.
>
> **Not supported yet:** OpenAI Responses API, Anthropic Messages API, WebSockets, HTTP/2 upstreams,
> `HTTP(S)_PROXY` for upstream connections.
>
> **Requirements:** Node.js ≥ 22.12.

The "Tested on" line may only stay if those CI jobs pass on the release commit.

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

Evaluated on 2026-10-09 against the local release candidate (`main` plus the release-review commits, not yet pushed;
see [RELEASE_AUDIT_0.1.0.md](RELEASE_AUDIT_0.1.0.md)). `NOT VERIFIED` means there is no evidence yet; it is not a pass.

| Gate          | Criterion                                  | Status           | Evidence                                                                                                                                                                               |
| ------------- | ------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness   | Unit, integration, contract, E2E           | **PASS** (local) | `pnpm verify`: 212 unit + 103 integration/contract, 36 smoke checks, 6 E2E (Linux). Integration suite also 103/103 twice under emulated Windows timers                                 |
| Security      | No known unmitigated Critical/High         | **PASS**         | Internal review: no Critical/High/Medium; SEC-R1..R5 fixed with failing-first tests; SEC-R6 (Low) accepted residual risk; `pnpm audit` 0 advisories. No external audit                 |
| Packaging     | External installation works                | **PASS** (local) | Tarball-only install in an isolated project; `pnpm test:pack` 57/57; strict TypeScript consumer compiles and runs                                                                      |
| Portability   | Linux, Windows, macOS verified             | **NOT VERIFIED** | Last full green CI: run #3 on `867b95e`. Run #4 (`2133883`) failed on Windows (XP-10, now fixed). The fixes are verified on Linux and under timer emulation, not yet on GitHub runners |
| Documentation | Accurate and synchronized                  | **PASS**         | Status, release, threat model, changelog and audit documents updated in the same change set; stale entries corrected (DOC-4)                                                           |
| DX            | First-time developer journey verified      | **PASS** (Linux) | 14/14 journey steps from the installed package, including the Studio in Chromium and replay with the upstream stopped                                                                  |
| Performance   | No confirmed severe regression             | **PASS**         | Benchmarks within VM noise of BENCHMARKS.md; decoder flat from 64 B to 256 KiB chunks (PERF-1 not returned)                                                                            |
| Release       | Package names, access and process reviewed | **NOT VERIFIED** | Names unpublished and `@tokenfault` scope not found; ownership needs the maintainer's npm login. Process, order, smoke tests and rollback documented above                             |

**Technical readiness:** conditional on a green CI run of the release candidate on every platform.
**Publication authorization:** the maintainer's decision; nothing is published, tagged or released automatically.
