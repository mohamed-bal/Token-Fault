import { describeError } from '@tokenfault/shared';
import { runDoctor } from './commands/doctor.js';
import { runInspect } from './commands/inspect.js';
import { runMock } from './commands/mock.js';
import { runProxy } from './commands/proxy.js';
import { runReplayCommand } from './commands/replay.js';
import { runScenarios } from './commands/scenarios.js';
import { CliError, EXIT, UsageError } from './errors.js';
import { cliVersion } from './meta.js';
import { err, out } from './output.js';

export const MAIN_HELP = `TokenFault — inspect, replay, break and harden AI streaming applications.

Usage: tokenfault <command> [options]

Commands:
  proxy       Run the streaming proxy and Studio in front of an OpenAI-compatible API
  mock        Run a deterministic OpenAI-compatible mock LLM (no API key needed)
  inspect     Send one streaming request and show events, metrics and diagnostics
  scenarios   List fault scenarios (A–I) and fault types
  replay      Replay a recorded stream locally or serve it over HTTP
  doctor      Check the local environment

Quick start:
  tokenfault proxy --mock                 # proxy + embedded mock + Studio
  tokenfault inspect --scenario mid-stream-disconnect

Global options:
  -h, --help      Show help (also: tokenfault <command> --help)
  -v, --version   Show the version

Exit codes: 0 success, 1 error, 2 usage error, 3 stream did not complete (inspect/replay),
130 interrupted.
`;

const COMMANDS: Record<string, (argv: readonly string[]) => Promise<number> | number> = {
  proxy: runProxy,
  mock: runMock,
  inspect: runInspect,
  scenarios: runScenarios,
  replay: runReplayCommand,
  doctor: runDoctor,
};

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    out(MAIN_HELP);
    return command === undefined ? EXIT.usage : EXIT.ok;
  }
  if (command === '-v' || command === '--version') {
    out(cliVersion());
    return EXIT.ok;
  }
  const run = COMMANDS[command];
  if (!run) {
    err(`Unknown command "${command}". Run \`tokenfault --help\` for the list of commands.`);
    return EXIT.usage;
  }
  try {
    return await run(rest);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}`);
      err(`Run \`tokenfault ${command} --help\` for usage.`);
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      err(`error: ${error.message}`);
      return EXIT.failure;
    }
    const code = (error as { code?: unknown }).code;
    if (code === 'EADDRINUSE') {
      err(`error: ${describeError(error)}. Choose another port with --port.`);
      return EXIT.failure;
    }
    err(`error: ${describeError(error)}`);
    if (process.env['TOKENFAULT_DEBUG'] && error instanceof Error && error.stack) err(error.stack);
    return EXIT.failure;
  }
}
