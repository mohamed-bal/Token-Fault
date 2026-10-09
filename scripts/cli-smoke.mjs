// CLI smoke test: exercises the *built* `tokenfault` binary end-to-end.
// Run after `pnpm build`. Uses only loopback ports and the embedded mock.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const results = [];
let failed = false;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  if (!condition) failed = true;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Starts a long-running command and resolves with the first URL it prints. */
function start(args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no URL printed by ${args.join(' ')}:\n${output}`)),
      15_000,
    );
    const onData = (d) => {
      output += d.toString();
      const m = /listening on (http:\/\/[^\s]+)|on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(m[1] ?? m[2]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (output += d.toString()));
    child.once('exit', (code) => reject(new Error(`exited early (${code}):\n${output}`)));
  });
  // Resolves { code, signal }. On Windows, kill() terminates unconditionally (no signal
  // handler runs), so graceful-shutdown exit codes can only be asserted on POSIX.
  const stop = (signal = 'SIGINT') =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: -1, signal: 'timeout' });
      }, 8_000);
      child.once('exit', (code, sig) => {
        clearTimeout(timer);
        resolve({ code, signal: sig });
      });
      child.kill(signal);
    });
  const waitFor = (re, ms = 5_000) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const poll = () => {
        const m = re.exec(output);
        if (m) resolve(m);
        else if (Date.now() > deadline)
          reject(new Error(`timed out waiting for ${re}:\n${output}`));
        else setTimeout(poll, 20);
      };
      poll();
    });
  return { url, stop, waitFor, output: () => output };
}

const WIN = process.platform === 'win32';
/** Graceful exit (code 0) on POSIX; on Windows only that the process terminated. */
const exitedGracefully = (r) => (WIN ? r.code !== null || r.signal !== null : r.code === 0);

const tmp = await mkdtemp(path.join(tmpdir(), 'tokenfault-smoke-'));
try {
  // Basics
  const version = run(['--version']);
  check(
    '--version exits 0',
    version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
    version.stdout.trim(),
  );
  check('no command exits 2 with help', run([]).code === 2);
  check('unknown command exits 2', run(['bogus']).code === 2);
  for (const cmd of ['proxy', 'mock', 'inspect', 'scenarios', 'replay', 'doctor']) {
    const h = run([cmd, '--help']);
    check(`${cmd} --help`, h.code === 0 && h.stdout.includes(`tokenfault ${cmd}`));
  }

  const scenarios = run(['scenarios', '--json']);
  const parsed = JSON.parse(scenarios.stdout);
  check(
    'scenarios --json lists A–I',
    scenarios.code === 0 && parsed.scenarios.map((s) => s.letter).join('') === 'ABCDEFGHI',
  );

  const doctor = run(['doctor', '--json']);
  check('doctor --json', doctor.code === 0 && JSON.parse(doctor.stdout).ok === true);
  check('doctor rejects bad target', run(['doctor', '--target', 'ftp://x', '--json']).code === 1);

  // Usage errors
  check('proxy without target exits 2', run(['proxy']).code === 2);
  check(
    'proxy with unsafe target exits 2',
    run(['proxy', '--target', 'http://user:pw@x']).code === 2,
  );
  check(
    'proxy refuses 0.0.0.0 without --allow-remote',
    run(['proxy', '--mock', '--host', '0.0.0.0']).code === 2,
  );
  check(
    'inspect with unset key env exits 2',
    run(['inspect', '--mock', '--api-key-env', 'TOKENFAULT_SMOKE_UNSET']).code === 2,
  );
  check(
    'inspect with bad --header exits 2',
    run(['inspect', '--mock', '--header', 'nocolon']).code === 2,
  );

  // Direct mock inspection
  const direct = run(['inspect', '--mock', '--json']);
  const directReport = JSON.parse(direct.stdout);
  check(
    'inspect --mock completes',
    direct.code === 0 && directReport.outcome === 'completed',
    `${directReport.metrics?.eventCount} events`,
  );

  // Proxy + embedded mock
  const proxy = start(['proxy', '--mock', '--port', '0']);
  const proxyUrl = await proxy.url;
  const [, controlToken] = await proxy.waitFor(/control token (\S+)/);
  check('proxy prints a control token', /^[A-Za-z0-9_-]{43}$/.test(controlToken));
  const infoNoToken = await fetch(`${proxyUrl}/__tokenfault/api/info`);
  const infoWithToken = await fetch(`${proxyUrl}/__tokenfault/api/info`, {
    headers: { authorization: `Bearer ${controlToken}` },
  });
  check(
    'control API requires the printed token',
    infoNoToken.status === 401 && infoWithToken.status === 200,
  );
  check('proxy --mock starts', /^http:\/\/127\.0\.0\.1:\d+$/.test(proxyUrl), proxyUrl);
  const endpoint = `${proxyUrl}/v1/chat/completions`;

  const ok = run(['inspect', '--url', endpoint, '--json']);
  check(
    'inspect through proxy completes',
    ok.code === 0 && JSON.parse(ok.stdout).outcome === 'completed',
  );

  const recordPath = path.join(tmp, 'disconnect.tfrec.json');
  const broken = run([
    'inspect',
    '--url',
    endpoint,
    '--scenario',
    'mid-stream-disconnect',
    '--record',
    recordPath,
    '--json',
  ]);
  const brokenReport = JSON.parse(broken.stdout);
  check(
    'injected disconnect exits 3',
    broken.code === 3 && brokenReport.outcome === 'incomplete',
    `${brokenReport.metrics.eventCount} events, ${brokenReport.termination.kind}`,
  );
  check(
    'recording written with mode 0600',
    ((await stat(recordPath)).mode & 0o777) === 0o600 || process.platform === 'win32',
  );
  const recordingText = await readFile(recordPath, 'utf8');
  check(
    'recording excludes payloads by default',
    !recordingText.includes('TokenFault mock response') &&
      JSON.parse(recordingText).payloads.included === false,
  );
  check(
    'recording refuses to overwrite',
    run(['inspect', '--url', endpoint, '--record', recordPath]).code === 1,
  );

  const rateLimited = run(['inspect', '--url', endpoint, '--scenario', 'rate-limit-429', '--json']);
  check(
    '429 scenario exits 3',
    rateLimited.code === 3 && JSON.parse(rateLimited.stdout).status === 429,
  );

  const live = run(['inspect', '--url', endpoint]);
  check(
    'human-readable inspect output',
    live.code === 0 && live.stdout.includes('Outcome') && live.stdout.includes('[DONE]'),
  );

  const proxyExit = await proxy.stop('SIGINT');
  check(
    'proxy shuts down gracefully on SIGINT',
    exitedGracefully(proxyExit),
    JSON.stringify(proxyExit),
  );
  check('inspect against a stopped proxy exits 1', run(['inspect', '--url', endpoint]).code === 1);

  // Replay
  const replayLocal = run(['replay', recordPath, '--speed', '20', '--json']);
  const replayReport = JSON.parse(replayLocal.stdout);
  check(
    'local replay reproduces the incomplete stream',
    replayLocal.code === 3 &&
      replayReport.outcome === 'incomplete' &&
      replayReport.metrics.eventCount === 5,
  );
  check('replay rejects a non-recording file', run(['replay', path.join(tmp)]).code === 1);

  const served = start(['replay', recordPath, '--serve', '--port', '0', '--speed', '10']);
  const servedUrl = await served.url;
  const fromServed = run(['inspect', '--url', `${servedUrl}/v1/chat/completions`, '--json']);
  const servedReport = JSON.parse(fromServed.stdout);
  check(
    'served replay reproduces the failure',
    fromServed.code === 3 &&
      servedReport.metrics.eventCount === 5 &&
      servedReport.termination.kind === 'upstream-reset',
  );
  check('replay server shuts down on SIGTERM', exitedGracefully(await served.stop('SIGTERM')));

  // Standalone mock
  const mock = start(['mock', '--port', '0', '--scenario', 'stream-stall']);
  const mockUrl = await mock.url;
  const stalled = run(['inspect', '--url', `${mockUrl}/v1/chat/completions`, '--json']);
  check(
    'mock --scenario applies to every request',
    stalled.code === 0 && JSON.parse(stalled.stdout).metrics.eventGaps.maxMs >= 3900,
  );
  check('mock shuts down on SIGINT', exitedGracefully(await mock.stop()));
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} smoke checks passed`);
process.exit(failed ? 1 : 0);
