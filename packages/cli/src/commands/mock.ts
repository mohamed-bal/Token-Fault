import { startMockLlm } from '@tokenfault/mock-llm';
import { isLoopbackBindHost } from '@tokenfault/core/node';
import { DEFAULT_MOCK_PORT } from '@tokenfault/shared';
import { intOption, parse } from '../args.js';
import { EXIT, UsageError } from '../errors.js';
import { waitForShutdown } from '../lifecycle.js';
import { err, out, style } from '../output.js';

export const MOCK_HELP = `Usage: tokenfault mock [options]

Start a deterministic OpenAI-compatible mock LLM server (no API key, no network).

Endpoints:
  POST /v1/chat/completions   streaming and non-streaming, tool calls
  GET  /v1/models
  GET  /healthz

Options:
  --host <addr>          Bind address (default 127.0.0.1)
  --port <n>             Port (default ${DEFAULT_MOCK_PORT}; 0 = random)
  --allow-remote         Required to bind a non-loopback address
  --scenario <id>        Default fault scenario for every request (see \`tokenfault scenarios\`)
  --interval-ms <n>      Delay between SSE events (default 20)
  --log                  Log requests (query strings redacted)
  -h, --help             Show this help

Per request, send \`x-tokenfault-scenario: <id>\` or \`x-tokenfault-faults: <json>\` to select faults.
`;

export async function runMock(argv: readonly string[]): Promise<number> {
  const { values } = parse(argv, {
    host: { type: 'string' },
    port: { type: 'string' },
    'allow-remote': { type: 'boolean' },
    scenario: { type: 'string' },
    'interval-ms': { type: 'string' },
    log: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(MOCK_HELP);
    return EXIT.ok;
  }
  const host = values.host ?? '127.0.0.1';
  if (!isLoopbackBindHost(host) && values['allow-remote'] !== true) {
    throw new UsageError(
      `Refusing to bind ${host} without --allow-remote (this exposes the mock server to the network).`,
    );
  }
  let mock;
  try {
    mock = await startMockLlm({
      host,
      port: intOption(values.port, 'port', 0, 65_535) ?? DEFAULT_MOCK_PORT,
      scenarioId: values.scenario ?? null,
      eventIntervalMs: intOption(values['interval-ms'], 'interval-ms', 0, 60_000) ?? 20,
      logger: values.log === true,
    });
  } catch (error) {
    if (error instanceof Error && /Unknown scenario/.test(error.message))
      throw new UsageError(error.message);
    throw error;
  }
  out(`${style.green('●')} TokenFault mock LLM listening on ${style.bold(mock.url)}`);
  out(`  POST ${mock.url}/v1/chat/completions`);
  if (values.scenario) out(`  default scenario: ${values.scenario}`);
  err('Press Ctrl+C to stop.');
  return waitForShutdown(() => mock.close());
}
