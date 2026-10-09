#!/usr/bin/env node
import { main } from './cli.js';

const code = await main(process.argv.slice(2));
// Long-running commands resolve only after a graceful shutdown; exit explicitly
// so lingering keep-alive sockets cannot hold the process open.
process.exit(code);
