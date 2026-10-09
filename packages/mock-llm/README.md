# @tokenfault/mock-llm

A deterministic OpenAI-compatible Chat Completions mock server (streaming and non-streaming, tool calls) with the
TokenFault fault scenarios built in. Token usage it reports is synthetic. No API key or network access needed.

> **Status:** pre-release (`0.x`). Not published to npm yet; build from source as described in the
> [repository README](https://github.com/mohamed-bal/Token-Fault#readme). Requires Node.js ≥ 22.12.

```ts
import { startMockLlm } from '@tokenfault/mock-llm';

const mock = await startMockLlm({ port: 0 });
// POST `${mock.url}/v1/chat/completions` with {"stream": true, ...}
await mock.close();
```

MIT · <https://github.com/mohamed-bal/Token-Fault>
