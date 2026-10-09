/**
 * Usage (with `tokenfault proxy --mock` running on the default port):
 *
 *   node examples/basic-client/src/main.ts [scenario]
 *
 * Try: none, mid-stream-disconnect, stream-stall, rate-limit-429, fragmented-sse.
 */
import { StreamError, resilientChat } from './resilient-client.ts';

const scenario = process.argv[2] ?? 'none';
const baseUrl = process.env['TOKENFAULT_URL'] ?? 'http://127.0.0.1:8787';

try {
  const result = await resilientChat({
    baseUrl,
    prompt: 'Explain why streaming clients need idle timeouts.',
    headers: { 'x-tokenfault-scenario': scenario },
    idleTimeoutMs: 2_000,
    onDelta: (t) => process.stdout.write(t),
  });
  process.stdout.write(
    `\n\n✔ completed after ${result.attempts} attempt(s), finish_reason=${result.finishReason}\n`,
  );
} catch (error) {
  if (error instanceof StreamError) {
    process.stdout.write(`\n\n✖ ${error.kind}: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
