# @tokenfault/proxy

The TokenFault streaming proxy as a library: forwards OpenAI-compatible traffic to a fixed upstream, inspects SSE in
flight, injects faults, records and replays sessions, and hosts the Studio and its token-protected control API.
Most users want the `tokenfault` CLI or `@tokenfault/testing` instead.

> **Status:** pre-release (`0.x`). Not published to npm yet; build from source as described in the
> [repository README](https://github.com/mohamed-bal/Token-Fault#readme). Requires Node.js ≥ 22.12.

```ts
import { createTokenFaultServer } from '@tokenfault/proxy';

const server = createTokenFaultServer({ target: 'http://127.0.0.1:4010', port: 0 });
const url = await server.listen();
// server.controlToken: send as "Authorization: Bearer <token>" to `${url}/__tokenfault/api/*`
await server.close();
```

MIT · <https://github.com/mohamed-bal/Token-Fault>
