# @tokenfault/core

The TokenFault streaming engine:

- incremental, byte-level WHATWG SSE decoder (`SseDecoder`) with bounded memory and UTF-8 validation;
- OpenAI Chat Completions stream interpreter (`ChatStreamAccumulator`) and stream metrics (`StreamInspector`);
- deterministic, seedable fault planner and executor (`FaultPlanner`, `SCENARIOS`);
- recording format v1 (`createRecording`, `parseRecording`) and replay (`createReplayPlan`, `runReplay`).

The main entry point is platform-agnostic. `@tokenfault/core/node` adds Node.js HTTP helpers
(`streamRequest`, `writeWithBackpressure`, `terminateResponse`, …).

> **Status:** pre-release (`0.x`). Not published to npm yet; build from source as described in the
> [repository README](https://github.com/mohamed-bal/Token-Fault#readme). Requires Node.js ≥ 22.12.

```ts
import { SseDecoder } from '@tokenfault/core';

const decoder = new SseDecoder({ maxEventBytes: 1024 * 1024 });
for (const item of decoder.push(new TextEncoder().encode('data: hi\n\n'))) {
  if (item.kind === 'event') console.log(item.event.data);
}
```

MIT · <https://github.com/mohamed-bal/Token-Fault>
