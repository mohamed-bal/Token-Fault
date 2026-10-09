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
 * Locates the built Studio bundle. Order: `TOKENFAULT_STUDIO_DIR`, then the
 * installed `@tokenfault/studio` package, then the monorepo checkout.
 * Returns `null` when no `index.html` is found (Studio disabled).
 */
export function findStudioDir(): string | null {
  const candidates: string[] = [];
  const fromEnv = process.env['TOKENFAULT_STUDIO_DIR'];
  if (fromEnv) candidates.push(path.resolve(fromEnv));
  try {
    const pkgJson = fileURLToPath(import.meta.resolve('@tokenfault/studio/package.json'));
    candidates.push(path.join(path.dirname(pkgJson), 'dist'));
  } catch {
    // Not installed as a dependency.
  }
  candidates.push(fileURLToPath(new URL('../../../apps/studio/dist', import.meta.url)));
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html'))) ?? null;
}
