#!/usr/bin/env node
import { main } from './cli.js';

const code = await main(process.argv.slice(2));
// Long-running commands resolve only after a graceful shutdown, so the process is
// exited explicitly (lingering keep-alive sockets must not hold it open). On
// POSIX pipes stdout/stderr are asynchronous: exiting immediately could truncate
// large `--json` output, so both streams are flushed first.
process.exitCode = code;
const flush = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => {
    if (stream.writableLength === 0) resolve();
    else stream.write('', () => resolve());
  });
await Promise.all([flush(process.stdout), flush(process.stderr)]);
process.exit(code);
