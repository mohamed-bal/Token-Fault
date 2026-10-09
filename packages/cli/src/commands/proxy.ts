import path from 'node:path';
import { startMockLlm } from '@tokenfault/mock-llm';
import type { RunningMockLlm } from '@tokenfault/mock-llm';
import { ConfigError, createTokenFaultServer } from '@tokenfault/proxy';
import { DEFAULT_PROXY_PORT, STUDIO_PREFIX } from '@tokenfault/shared';
import { intOption, parse } from '../args.js';
import { EXIT, UsageError } from '../errors.js';
import { waitForShutdown } from '../lifecycle.js';
import { cliVersion, findStudioDir } from '../meta.js';
import { err, out, style, warn } from '../output.js';

export const PROXY_HELP = `Usage: tokenfault proxy (--target <url> | --mock) [options]

Run the TokenFault streaming proxy and Studio. Point your application's
OpenAI-compatible base URL at the proxy; requests are forwarded to the
target, inspected in flight, and optionally broken on purpose.

Target:
  --target <url>              Upstream base URL, e.g. http://localhost:4010 or https://api.openai.com
                              (fixed at startup; never taken from requests)
  --mock                      Start an embedded mock LLM and use it as the target

Network:
  --host <addr>               Bind address (default 127.0.0.1)
  --port <n>                  Port (default ${DEFAULT_PROXY_PORT}; 0 = random)
  --allow-remote              Required to bind a non-loopback address. The Studio and
                              control API remain loopback-only.
  --headers-timeout-ms <n>    Max wait for upstream response headers (default 60000)
  --idle-timeout-ms <n>       Max gap between upstream body chunks (default 120000)

Faults:
  --scenario <id>             Apply a scenario to every request (see \`tokenfault scenarios\`)

Privacy and recording:
  --no-capture-payloads       Do not keep response payloads in memory (metrics only)
  --record-dir <dir>          Write each finished session to <dir> as a recording
  --record-payloads           Include response payloads in recordings (off by default)
  --record-max-files <n>      Keep at most n recordings (default 100)
  --record-max-age-days <n>   Delete recordings older than n days (default 14)

Other:
  --no-studio                 Do not serve the Studio UI

Control API / Studio access:
  A random control token is generated on every start and printed below. Sign in to the
  Studio with it; scripts send it as "Authorization: Bearer <token>".
  TOKENFAULT_CONTROL_TOKEN    Environment variable: use this token instead (≥ 32 printable chars)
  --no-control-auth           Disable control-plane authentication (any local process can then
                              read captured responses and change faults)
  --log                       Log requests (credentials and query values redacted)
  -h, --help                  Show this help
`;

/** Reads TOKENFAULT_CONTROL_TOKEN; tokens are never accepted as command-line values. */
function controlTokenFromEnv(): string | null {
  const value = process.env['TOKENFAULT_CONTROL_TOKEN'];
  if (value === undefined || value === '') return null;
  if (value.length < 32 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new UsageError(
      'TOKENFAULT_CONTROL_TOKEN must be at least 32 printable characters without spaces.',
    );
  }
  return value;
}

export async function runProxy(argv: readonly string[]): Promise<number> {
  const { values } = parse(argv, {
    target: { type: 'string' },
    mock: { type: 'boolean' },
    host: { type: 'string' },
    port: { type: 'string' },
    'allow-remote': { type: 'boolean' },
    'headers-timeout-ms': { type: 'string' },
    'idle-timeout-ms': { type: 'string' },
    scenario: { type: 'string' },
    'no-capture-payloads': { type: 'boolean' },
    'record-dir': { type: 'string' },
    'record-payloads': { type: 'boolean' },
    'record-max-files': { type: 'string' },
    'record-max-age-days': { type: 'string' },
    'no-studio': { type: 'boolean' },
    'no-control-auth': { type: 'boolean' },
    log: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(PROXY_HELP);
    return EXIT.ok;
  }
  if ((values.target === undefined) === (values.mock !== true)) {
    throw new UsageError('Specify exactly one of --target <url> or --mock.');
  }
  if (values['record-payloads'] && !values['record-dir'])
    throw new UsageError('--record-payloads requires --record-dir.');
  if (values['record-payloads'] && values['no-capture-payloads']) {
    throw new UsageError('--record-payloads cannot be combined with --no-capture-payloads.');
  }

  const port = intOption(values.port, 'port', 0, 65_535) ?? DEFAULT_PROXY_PORT;
  const headersTimeoutMs = intOption(
    values['headers-timeout-ms'],
    'headers-timeout-ms',
    100,
    3_600_000,
  );
  const idleTimeoutMs = intOption(values['idle-timeout-ms'], 'idle-timeout-ms', 100, 3_600_000);
  const recordMaxFiles = intOption(values['record-max-files'], 'record-max-files', 1, 100_000);
  const recordMaxAgeDays = intOption(
    values['record-max-age-days'],
    'record-max-age-days',
    1,
    3_650,
  );
  const studioDir = values['no-studio'] ? null : findStudioDir();
  const envToken = values['no-control-auth'] ? null : controlTokenFromEnv();

  let mock: RunningMockLlm | null = null;
  let target = values.target ?? '';
  if (values.mock) {
    mock = await startMockLlm({ host: '127.0.0.1', port: 0 });
    target = mock.url;
  }

  let server;
  try {
    server = createTokenFaultServer({
      target,
      host: values.host ?? '127.0.0.1',
      port,
      allowRemote: values['allow-remote'] === true,
      capturePayloads: values['no-capture-payloads'] !== true,
      scenarioId: values.scenario ?? null,
      recordDir: values['record-dir'] ? path.resolve(values['record-dir']) : null,
      recordPayloads: values['record-payloads'] === true,
      studioDir,
      ...(values['no-control-auth']
        ? { controlToken: null }
        : envToken
          ? { controlToken: envToken }
          : {}),
      logger: values.log === true,
      version: cliVersion(),
      ...(headersTimeoutMs !== undefined ? { headersTimeoutMs } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(recordMaxFiles !== undefined ? { recordMaxFiles } : {}),
      ...(recordMaxAgeDays !== undefined ? { recordMaxAgeDays } : {}),
    });
  } catch (error) {
    await mock?.close();
    if (error instanceof ConfigError) throw new UsageError(error.message);
    throw error;
  }

  let url: string;
  try {
    url = await server.listen();
  } catch (error) {
    await mock?.close();
    throw error;
  }
  const targetDisplay = server.targetDisplay;

  out(`${style.green('●')} TokenFault proxy listening on ${style.bold(url)}`);
  out(`  target   ${targetDisplay}${mock ? style.dim(' (embedded mock)') : ''}`);
  // OpenAI SDKs expect a base URL ending in /v1; the proxy appends request paths to the target.
  const sdkBase = /\/v1$/.test(new URL(targetDisplay).pathname) ? url : `${url}/v1`;
  out(`  base URL ${sdkBase}${style.dim('  ← use as your OpenAI-compatible SDK base URL')}`);
  out(
    studioDir
      ? `  studio   ${style.cyan(`${url}${STUDIO_PREFIX}/`)}`
      : `  studio   ${style.dim('disabled (assets not built or --no-studio)')}`,
  );
  out(
    `  payloads ${values['no-capture-payloads'] ? 'not captured' : 'captured in memory only'}${values['record-dir'] ? `; recordings → ${path.resolve(values['record-dir'])} (${values['record-payloads'] ? 'with' : 'without'} payloads)` : ''}`,
  );
  if (values.scenario) out(`  faults   scenario ${values.scenario} on every request`);
  if (server.controlToken) {
    out(
      `  control token ${server.controlToken}  ${style.dim('(Studio sign-in / Authorization: Bearer; not logged)')}`,
    );
  } else {
    warn(
      'control-plane authentication is disabled (--no-control-auth): any local process can read captured responses and change faults.',
    );
  }
  if (values['allow-remote']) {
    warn(
      'the proxy data path is reachable from the network (--allow-remote): any host that can reach this port can send requests to your upstream through it.',
    );
  }
  err('Press Ctrl+C to stop.');

  return waitForShutdown(async () => {
    await server.close();
    await mock?.close();
  });
}
