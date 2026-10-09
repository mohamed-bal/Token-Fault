# @tokenfault/testing

Test helpers for AI streaming clients: start the TokenFault mock LLM and proxy in-process on loopback, send
streaming requests and assert on the inspected result. No API key or network access needed.

> **Status:** pre-release (`0.x`). Not published to npm yet; build from source as described in the
> [repository README](https://github.com/mohamed-bal/Token-Fault#readme). Requires Node.js ≥ 22.12.

```ts
import { startStack, streamChatCompletion } from '@tokenfault/testing';

const stack = await startStack();
try {
  const result = await streamChatCompletion(stack.proxy.url, { scenario: 'mid-stream-disconnect' });
  console.log(result.snapshot.outcome); // 'incomplete'
  console.log(await stack.proxy.control.sessions()); // control API; the token is handled for you
} finally {
  await stack.close();
}
```

Exports: `startStack`, `startProxy`, `startMockLlm`, `streamChatCompletion`, `streamRequest`,
`waitForSession`, `ControlClient`, `ControlApiError`.

MIT · <https://github.com/mohamed-bal/Token-Fault>
