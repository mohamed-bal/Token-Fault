import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { parseTarget } from '@tokenfault/proxy';
import { DEFAULT_MOCK_PORT, DEFAULT_PROXY_PORT, describeError } from '@tokenfault/shared';
import { intOption, parse } from '../args.js';
import { EXIT } from '../errors.js';
import { cliVersion, findStudioDir } from '../meta.js';
import { json, out, style } from '../output.js';

export const DOCTOR_HELP = `Usage: tokenfault doctor [options]

Check the local environment and configuration.

Options:
  --target <url>        Also validate an upstream target and check it is reachable
                        (one unauthenticated GET to the target's base URL; no credentials are sent)
  --port <n>            Proxy port to check (default ${DEFAULT_PROXY_PORT})
  --mock-port <n>       Mock port to check (default ${DEFAULT_MOCK_PORT})
  --record-dir <dir>    Check that recordings can be written to <dir>
  --json                Machine-readable output
  -h, --help            Show this help

Exit codes: 0 no failures (warnings allowed), 1 at least one check failed.
`;

type Status = 'pass' | 'warn' | 'fail' | 'info';
interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function probeTarget(url: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = fn(url, { method: 'GET', timeout: timeoutMs, headers: { accept: '*/*' } });
    req.on('response', (res) => {
      res.resume();
      resolve(`HTTP ${res.statusCode ?? '?'}`);
    });
    req.on('timeout', () => req.destroy(new Error(`no response within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

export async function runDoctor(argv: readonly string[]): Promise<number> {
  const { values } = parse(argv, {
    target: { type: 'string' },
    port: { type: 'string' },
    'mock-port': { type: 'string' },
    'record-dir': { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(DOCTOR_HELP);
    return EXIT.ok;
  }
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string): void =>
    void checks.push({ name, status, detail });

  add('tokenfault', 'info', `version ${cliVersion()}`);
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add(
    'node',
    major > 22 || (major === 22 && minor >= 12) ? 'pass' : 'fail',
    `Node.js ${process.versions.node} (requires >= 22.12) on ${process.platform}/${process.arch}`,
  );

  for (const [name, value, fallback] of [
    ['proxy port', values.port, DEFAULT_PROXY_PORT],
    ['mock port', values['mock-port'], DEFAULT_MOCK_PORT],
  ] as const) {
    const port = intOption(value, name.replace(' ', '-'), 1, 65_535) ?? fallback;
    const free = await portFree(port);
    add(
      name,
      free ? 'pass' : 'warn',
      free ? `127.0.0.1:${port} is free` : `127.0.0.1:${port} is in use (pick another with --port)`,
    );
  }

  const studio = findStudioDir();
  add(
    'studio',
    studio ? 'pass' : 'warn',
    studio
      ? `assets found at ${studio}`
      : 'assets not found; run `pnpm build` (the proxy still works without the Studio)',
  );

  const proxyVars = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].filter(
    (v) => process.env[v],
  );
  add(
    'outbound proxy',
    proxyVars.length > 0 ? 'warn' : 'pass',
    proxyVars.length > 0
      ? `${proxyVars.join(', ')} set, but TokenFault connects to the target directly (environment proxies are not used)`
      : 'no HTTP(S)_PROXY variables set',
  );

  if (values.target !== undefined) {
    try {
      const target = parseTarget(values.target);
      add('target', 'pass', `valid: ${target.display}`);
      try {
        add(
          'target reachable',
          'pass',
          `${await probeTarget(target.url, 5_000)} from ${target.display}`,
        );
      } catch (error) {
        add('target reachable', 'fail', `${target.display}: ${describeError(error)}`);
      }
    } catch (error) {
      add('target', 'fail', describeError(error));
    }
  }

  if (values['record-dir'] !== undefined) {
    const dir = path.resolve(values['record-dir']);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await access(dir, constants.W_OK);
      add('record dir', 'pass', `${dir} is writable`);
    } catch (error) {
      add('record dir', 'fail', `${dir}: ${describeError(error)}`);
    }
  }

  const failed = checks.some((c) => c.status === 'fail');
  if (values.json) {
    json({ ok: !failed, checks });
  } else {
    const icon: Record<Status, string> = {
      pass: style.green('✔'),
      warn: style.yellow('!'),
      fail: style.red('✖'),
      info: style.dim('·'),
    };
    for (const c of checks) out(`${icon[c.status]} ${c.name.padEnd(17)} ${c.detail}`);
    out();
    out(failed ? style.red('Some checks failed.') : style.green('No blocking problems found.'));
  }
  return failed ? EXIT.failure : EXIT.ok;
}
