// Marks a built CLI entry point as executable (no-op on Windows).
import { chmod } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('usage: chmod-bin.mjs <file>');
  process.exit(2);
}
if (process.platform !== 'win32') await chmod(file, 0o755);
