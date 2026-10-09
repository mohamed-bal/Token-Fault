// External installation test.
//
// Packs every publishable package with `pnpm pack` (which rewrites `workspace:*`
// to real versions), installs the tarballs into a fresh project OUTSIDE the
// monorepo with npm, and verifies the installed artifacts work:
// CLI binary, doctor, mock, proxy + Studio assets, inspect, ESM imports of
// @tokenfault/core and @tokenfault/testing, and TypeScript declarations.
//
// Run after `pnpm build`. Requires network access to the npm registry for
// third-party dependencies (fastify, zod, @types/node). Nothing is published.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WIN = process.platform === 'win32';
const PACKAGES = ['shared', 'core', 'mock-llm', 'proxy', 'testing', 'cli'];
const FORBIDDEN_IN_TARBALL = [
  /(^|\/)test\//,
  /\.tsbuildinfo$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)node_modules\//,
];

let failed = false;
const check = (name, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: WIN, timeout: 300_000, ...options });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const rootLicense = (await readFile(path.join(ROOT, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n');
const work = await mkdtemp(path.join(tmpdir(), 'tokenfault-pack-'));
const tarballs = path.join(work, 'tarballs');
const project = path.join(work, 'project');
try {
  // 1. Pack.
  const tgz = {};
  for (const name of PACKAGES) {
    const dir = path.join(ROOT, 'packages', name);
    const r = run('pnpm', ['pack', '--pack-destination', tarballs], { cwd: dir });
    if (r.code !== 0) throw new Error(`pnpm pack failed for ${name}:\n${r.stderr}${r.stdout}`);
  }
  for (const file of await readdir(tarballs)) {
    const base = file.replace(/-\d+\.\d+\.\d+.*\.tgz$/, '');
    tgz[base] = path.join(tarballs, file);
  }
  const expected = [
    'tokenfault-shared',
    'tokenfault-core',
    'tokenfault-mock-llm',
    'tokenfault-proxy',
    'tokenfault-testing',
    'tokenfault',
  ];
  check(
    'all packages packed',
    expected.every((n) => tgz[n]),
    Object.keys(tgz).join(', '),
  );

  // 2. Inspect tarball contents.
  for (const [base, file] of Object.entries(tgz)) {
    // Relative names and cwd: GNU tar would read a Windows drive letter ("C:") as a remote host.
    const tar = (args) => run('tar', [...args], { cwd: tarballs });
    const name = path.basename(file);
    const list = tar(['-tzf', name])
      .stdout.split(/\r?\n/)
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, ''));
    const manifest = JSON.parse(tar(['-xzOf', name, 'package/package.json']).stdout);
    const license = tar(['-xzOf', name, 'package/LICENSE']).stdout;
    const bad = list.filter((f) => FORBIDDEN_IN_TARBALL.some((re) => re.test(f)));
    check(
      `${base}: no tests/build metadata in tarball`,
      bad.length === 0,
      bad.slice(0, 3).join(', '),
    );
    check(
      `${base}: LICENSE and README included`,
      list.includes('LICENSE') && list.includes('README.md'),
    );
    check(
      `${base}: LICENSE matches the repository LICENSE`,
      license.replace(/\r\n/g, '\n') === rootLicense,
    );
    check(`${base}: no workspace: protocol left`, !JSON.stringify(manifest).includes('workspace:'));
    check(
      `${base}: engines and repository metadata`,
      manifest.engines?.node === '>=22.12.0' && typeof manifest.repository?.url === 'string',
    );
    // Source maps must point at files that are in the tarball.
    const maps = list.filter((f) => f.endsWith('.js.map'));
    const missingSources = [];
    for (const map of maps.slice(0, 20)) {
      const { sources } = JSON.parse(tar(['-xzOf', name, `package/${map}`]).stdout);
      for (const src of sources) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(map), src));
        if (!list.includes(resolved)) missingSources.push(`${map} → ${src}`);
      }
    }
    check(
      `${base}: source maps resolve inside the package`,
      maps.length > 0 && missingSources.length === 0,
      missingSources.slice(0, 2).join(', '),
    );
    check(`${base}: not private`, manifest.private !== true);
    if (base === 'tokenfault') {
      check(
        'tokenfault: Studio assets bundled',
        list.includes('studio/index.html') && list.some((f) => f.startsWith('studio/assets/')),
      );
      check(
        'tokenfault: Studio third-party licenses included',
        list.includes('studio/THIRD_PARTY_LICENSES.txt'),
      );
      check(
        'tokenfault: no runtime dependency on private packages',
        !Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).includes(
          '@tokenfault/studio',
        ),
      );
      check(
        'tokenfault: bin entry present',
        list.includes(manifest.bin?.tokenfault?.replace(/^\.\//, '') ?? '-'),
      );
    }
  }

  // 3. Install into a project outside the monorepo. `overrides` force every
  //    internal dependency to the local tarball (nothing is fetched from npm under @tokenfault).
  const fileSpec = (base) => `file:${tgz[base].split(path.sep).join('/')}`;
  const overrides = Object.fromEntries(
    ['shared', 'core', 'mock-llm', 'proxy', 'testing'].map((n) => [
      `@tokenfault/${n}`,
      fileSpec(`tokenfault-${n}`),
    ]),
  );
  await writeFile(
    path.join(work, 'package.json'),
    '{}', // keeps npm from walking up to an unrelated parent project
  );
  await rm(project, { recursive: true, force: true });
  await mkdir(project);
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify(
      {
        name: 'tokenfault-external-install-test',
        private: true,
        type: 'module',
        dependencies: {
          tokenfault: fileSpec('tokenfault'),
          '@tokenfault/core': fileSpec('tokenfault-core'),
          '@tokenfault/testing': fileSpec('tokenfault-testing'),
          '@tokenfault/mock-llm': fileSpec('tokenfault-mock-llm'),
          '@tokenfault/proxy': fileSpec('tokenfault-proxy'),
        },
        devDependencies: { '@types/node': '22.20.4' },
        overrides,
      },
      null,
      2,
    ),
  );
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: project,
  });
  check(
    'npm install from tarballs',
    install.code === 0,
    install.code === 0 ? '' : install.stderr.slice(-800),
  );
  if (install.code !== 0) throw new Error('install failed');

  // 4. CLI checks.
  const bin = path.join(project, 'node_modules', '.bin', WIN ? 'tokenfault.cmd' : 'tokenfault');
  const cli = (args, opts = {}) =>
    run(bin, args, { cwd: project, env: { ...process.env, NO_COLOR: '1' }, ...opts });
  const version = cli(['--version']);
  check(
    'installed CLI runs',
    version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
    version.stdout.trim(),
  );
  const doctor = cli(['doctor', '--json', '--port', '1', '--mock-port', '2']);
  let doctorReport = null;
  try {
    doctorReport = JSON.parse(doctor.stdout);
  } catch {
    // reported below
  }
  check(
    'doctor finds bundled Studio assets',
    doctorReport?.checks?.some((c) => c.name === 'studio' && c.status === 'pass') === true,
  );
  const inspectMock = cli(['inspect', '--mock', '--json']);
  check(
    'inspect --mock completes',
    inspectMock.code === 0 && JSON.parse(inspectMock.stdout).outcome === 'completed',
  );

  // 5. Proxy + Studio from the installed package.
  const child = spawn(bin, ['proxy', '--mock', '--port', '0'], {
    cwd: project,
    shell: WIN,
    env: { ...process.env, NO_COLOR: '1' },
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy did not start:\n${output}`)), 20_000);
    const onData = (d) => {
      output += d.toString();
      // Wait for the control-token line too; it is printed after the URL.
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m && /control token\s+\S+/.test(output)) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (output += d.toString()));
  });
  const token = /control token\s+(\S+)/.exec(output)?.[1] ?? '';
  const unauthenticated = await fetch(`${url}/__tokenfault/api/info`);
  check('control API refuses requests without the token', unauthenticated.status === 401);
  const authHeaders = { authorization: `Bearer ${token}` };
  const studio = await fetch(`${url}/__tokenfault/studio/`);
  check(
    'proxy serves bundled Studio',
    studio.status === 200 && (await studio.text()).includes('<div id="root">'),
  );
  const info = await fetch(`${url}/__tokenfault/api/info`, { headers: authHeaders });
  check(
    'control API reachable with the printed token',
    info.status === 200,
    `status ${info.status}`,
  );
  const viaProxy = cli(['inspect', '--url', `${url}/v1/chat/completions`, '--json']);
  check(
    'inspect through installed proxy completes',
    viaProxy.code === 0 && JSON.parse(viaProxy.stdout).outcome === 'completed',
  );
  if (WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGINT');

  // 6. Library imports (ESM) from the installed packages.
  await writeFile(
    path.join(project, 'consumer.mjs'),
    `import { SseDecoder, SCENARIOS } from '@tokenfault/core';
import { streamRequest } from '@tokenfault/core/node';
import { startStack, streamChatCompletion } from '@tokenfault/testing';
import { startMockLlm } from '@tokenfault/mock-llm';
import { createTokenFaultServer } from '@tokenfault/proxy';
const d = new SseDecoder();
const items = d.push(new TextEncoder().encode('data: hi\\n\\n'));
if (items[0]?.kind !== 'event' || SCENARIOS.length !== 9 || typeof streamRequest !== 'function') throw new Error('core exports broken');
// Examples from the package READMEs.
const mock = await startMockLlm({ port: 0 });
const server = createTokenFaultServer({ target: mock.url, port: 0 });
const proxyUrl = await server.listen();
const denied = await fetch(proxyUrl + '/__tokenfault/api/info');
const allowed = await fetch(proxyUrl + '/__tokenfault/api/info', { headers: { authorization: 'Bearer ' + server.controlToken } });
await server.close();
await mock.close();
if (denied.status !== 401 || allowed.status !== 200) throw new Error('proxy README example broken');
const stack = await startStack();
try {
  if (!Array.isArray(await stack.proxy.control.sessions())) throw new Error('control client broken');
  const r = await streamChatCompletion(stack.proxy.url, { scenario: 'mid-stream-disconnect' });
  if (r.snapshot.outcome !== 'incomplete' || r.snapshot.metrics.eventCount !== 5) throw new Error('unexpected ' + r.snapshot.outcome);
  console.log('consumer ok');
} finally {
  await stack.close();
}
`,
  );
  const consumer = run(process.execPath, ['consumer.mjs'], { cwd: project, shell: false });
  check(
    'ESM consumer: core, testing, mock-llm, proxy (README examples)',
    consumer.code === 0 && consumer.stdout.includes('consumer ok'),
    consumer.stderr.slice(-500),
  );

  // 7. TypeScript declarations resolve for consumers (strict, NodeNext, no skipLibCheck).
  await writeFile(
    path.join(project, 'types.ts'),
    `import { SseDecoder, createRecording, type Recording, type FaultProfile } from '@tokenfault/core';
import { writeWithBackpressure } from '@tokenfault/core/node';
import { startStack, type Stack, type StreamResult } from '@tokenfault/testing';
const d: SseDecoder = new SseDecoder({ maxEventBytes: 1024 });
export type T = [Recording, FaultProfile, Stack, StreamResult, typeof createRecording, typeof writeWithBackpressure, typeof startStack, typeof d];
`,
  );
  await writeFile(
    path.join(project, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2023',
        noEmit: true,
        skipLibCheck: false,
        types: ['node'],
      },
      files: ['types.ts'],
    }),
  );
  const tsc = run(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
    { cwd: project, shell: false },
  );
  check(
    'TypeScript declarations resolve (skipLibCheck: false)',
    tsc.code === 0,
    (tsc.stdout + tsc.stderr).slice(-800),
  );
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failed ? '\nexternal install test FAILED' : '\nexternal install test passed');
process.exit(failed ? 1 : 0);
