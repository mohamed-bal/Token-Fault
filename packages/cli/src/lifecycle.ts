import { EXIT } from './errors.js';
import { err } from './output.js';

/**
 * Keeps the process alive until SIGINT/SIGTERM, then runs `shutdown` once.
 * A second signal, or a shutdown that takes longer than `graceMs`, forces exit.
 */
export function waitForShutdown(shutdown: () => Promise<void>, graceMs = 5_000): Promise<number> {
  return new Promise((resolve) => {
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) {
        err(`Received ${signal} again; exiting immediately.`);
        process.exit(EXIT.interrupted);
      }
      stopping = true;
      err(`\nReceived ${signal}; shutting down…`);
      const force = setTimeout(() => {
        err(`Shutdown did not finish within ${graceMs} ms; exiting.`);
        process.exit(EXIT.failure);
      }, graceMs);
      force.unref();
      shutdown()
        .then(() => resolve(EXIT.ok))
        .catch((error: unknown) => {
          err(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
          resolve(EXIT.failure);
        })
        .finally(() => clearTimeout(force));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}
