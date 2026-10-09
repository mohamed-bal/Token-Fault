// Removes build outputs of the package in the current directory (portable `rm -rf`).
import { rmSync } from 'node:fs';

for (const target of ['dist', 'studio', 'tsconfig.build.tsbuildinfo', 'tsconfig.tsbuildinfo']) {
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
