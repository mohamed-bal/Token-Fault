# Contributing to TokenFault

Thanks for helping make AI streaming applications more reliable.

## Setup

Requirements: Node.js ≥ 22.12 and pnpm 10 (`corepack enable` installs the version pinned in `package.json`).

```bash
pnpm install
pnpm build          # builds every package and the Studio
pnpm verify         # build, typecheck, lint, format check, unit + integration tests, CLI smoke test, E2E
```

E2E tests need Chromium for Playwright: `pnpm exec playwright install chromium` (once).

## Repository layout

| Path                    | Contents                                             |
| ----------------------- | ---------------------------------------------------- |
| `packages/shared`       | Wire contracts, limits, redaction                    |
| `packages/core`         | Streaming engine, fault engine, recording, replay    |
| `packages/mock-llm`     | Mock OpenAI-compatible server                        |
| `packages/proxy`        | Proxy, control API, session store, recorder, replay  |
| `packages/testing`      | Test helpers for users and for our integration tests |
| `packages/cli`          | The `tokenfault` binary                              |
| `apps/studio`           | Studio UI                                            |
| `tests/integration`     | Real-socket integration and contract tests           |
| `tests/e2e`             | Playwright tests                                     |
| `scripts/cli-smoke.mjs` | CLI smoke test against the built binary              |
| `docs/engineering`      | Decisions, threat model, status, MVP spec            |

## Development loop

```bash
pnpm test:unit                         # fast: runs against TypeScript sources, no build needed
pnpm test:integration
pnpm tokenfault proxy --mock           # after `pnpm build`
pnpm --filter @tokenfault/studio dev   # Studio with hot reload; proxies the API to http://127.0.0.1:8787
```

## Rules for changes

- **Correctness before features.** Changes to the SSE decoder, framer, interpreter or fault planner need tests,
  including chunk-boundary cases. Partition-invariance tests must keep passing.
- **No fabricated data.** Metrics must be measured or reported by the API. UI states must reflect real server state.
- **No silent failures.** Errors are surfaced, logged (redacted) or turned into diagnostics. Never swallow them.
- **Strict TypeScript.** No `any`, no `@ts-ignore`, no disabled lint rules without a comment explaining why.
- **Security-sensitive code** (target handling, header forwarding, control-plane guard, static serving,
  recordings, redaction) needs a test for the attack it prevents. Read the threat model first.
- **Dependencies.** Add one only with a clear justification in the PR. Prefer the Node standard library.
- **Docs follow code.** If behaviour, flags or limits change, update the README, `--help`,
  `docs/engineering/IMPLEMENTATION_STATUS.md` and, for architectural changes, `docs/engineering/DECISIONS.md`.
- **Do not mark tests skipped** to make CI pass.

## Pull requests

1. Branch from `main`.
2. Keep each PR focused. Describe the problem, the change and how you verified it.
3. Make sure `pnpm verify` passes locally. If a step cannot run in your environment, say which and why.
4. Add a `CHANGELOG.md` entry under _Unreleased_ for user-visible changes.

## Code of conduct

Be respectful and constructive. Assume good intent, focus on the work, and keep discussions technical.
