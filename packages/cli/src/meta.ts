import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** CLI package version, read from package.json next to the build output. */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Locates the built Studio bundle. Order:
 * 1. `TOKENFAULT_STUDIO_DIR`;
 * 2. `studio/` inside this package (copied at build time; what the published package ships);
 * 3. `apps/studio/dist` of the TokenFault monorepo, only when that directory really belongs to
 *    `@tokenfault/studio` (so an unrelated `apps/studio` next to an install is never served).
 * Returns `null` when no `index.html` is found (Studio disabled). `moduleUrl` and `env` exist for tests.
 */
export function findStudioDir(
  moduleUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: string[] = [];
  const fromEnv = env['TOKENFAULT_STUDIO_DIR'];
  if (fromEnv) candidates.push(path.resolve(fromEnv));
  candidates.push(fileURLToPath(new URL('../studio', moduleUrl)));
  const monorepoStudio = fileURLToPath(new URL('../../../apps/studio', moduleUrl));
  if (isTokenFaultStudio(monorepoStudio)) candidates.push(path.join(monorepoStudio, 'dist'));
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}

function isTokenFaultStudio(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    return pkg.name === '@tokenfault/studio';
  } catch {
    return false;
  }
}
