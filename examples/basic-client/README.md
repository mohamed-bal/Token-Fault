# Example: resilient streaming client

`src/resilient-client.ts` is a small streaming chat client that survives the failures TokenFault injects.
It uses `fetch` plus the TokenFault SSE decoder and chat interpreter.

| Failure (scenario)                          | Client behaviour                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `rate-limit-429` / `server-unavailable-503` | Retries with exponential backoff and honours `Retry-After`.                |
| `slow-first-response`                       | First-byte timeout, kept separate from the idle timeout.                   |
| `stream-stall`                              | Idle timeout between chunks. Not retried once content has arrived.         |
| `mid-stream-disconnect`                     | Reported as `incomplete`. A clean close without `[DONE]` is never success. |
| `fragmented-sse`, `malformed-data`          | Byte-level SSE decoding: fragmentation is invisible, bad events surface.   |

## Run it

```bash
pnpm build
node packages/cli/dist/bin.js proxy --mock          # terminal 1
node examples/basic-client/src/main.ts                     # terminal 2: normal stream
node examples/basic-client/src/main.ts mid-stream-disconnect
node examples/basic-client/src/main.ts stream-stall
```

`main.ts` runs directly on Node ≥ 22.18, which strips TypeScript types natively.
The behaviour in the table is verified by `tests/integration/example-client.test.ts`.
