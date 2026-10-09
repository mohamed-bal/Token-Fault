// Copies the built Studio (apps/studio/dist) into the CLI package as `studio/`,
// so the published `tokenfault` package serves the Studio without depending on
// the private @tokenfault/studio workspace package. Run from packages/cli.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../apps/studio/dist', import.meta.url));
const target = path.resolve('studio');

if (!existsSync(path.join(source, 'index.html'))) {
  console.error(`copy-studio: ${source}/index.html not found; build @tokenfault/studio first.`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
cpSync(source, target, { recursive: true });
