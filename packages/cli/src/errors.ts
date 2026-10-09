/** Process exit codes. Documented in `tokenfault --help` and the README. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** `inspect`: the request completed but the stream did not (http-error, incomplete, stream-error). */
  streamFailure: 3,
  interrupted: 130,
} as const;

/** Invalid command-line usage. Printed without a stack trace, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Expected runtime failure (bad file, unreachable target, ...). Printed without a stack trace, exit code 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
