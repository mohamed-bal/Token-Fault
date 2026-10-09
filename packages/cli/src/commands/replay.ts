import { readFile, stat } from 'node:fs/promises';
import { StreamInspector, createReplayPlan, parseRecording, runReplay } from '@tokenfault/core';
import type { ReplayTiming } from '@tokenfault/shared';
import { DEFAULT_LIMITS, DEFAULT_REPLAY_PORT } from '@tokenfault/shared';
import { startReplayServer } from '@tokenfault/proxy';
import { isLoopbackBindHost } from '@tokenfault/core/node';
import { intOption, numberOption, parse } from '../args.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { waitForShutdown } from '../lifecycle.js';
import { err, json, out, style } from '../output.js';
import {
  diagnosticLine,
  eventHeader,
  eventLine,
  isFailureOutcome,
  printSummary,
} from '../report.js';

export const REPLAY_HELP = `Usage: tokenfault replay <recording.tfrec.json> [options]

Replay a recorded response stream without contacting any model.

By default the recording is replayed locally with its original timing and
inspected live. With --serve, it is served over HTTP so your application can
consume it again (every POST replays it from the start).

Replay re-sends recorded bytes or events. It does not regenerate a model
response, and payload-free recordings replay redacted placeholders.

Options:
  --speed <factor>        Replay faster (>1) or slower (<1) than recorded, 0.01–100
  --fixed-gap-ms <n>      Ignore recorded timing and space steps n ms apart
  --serve                 Serve the recording over HTTP instead of printing it
  --host <addr>           Bind address for --serve (default 127.0.0.1)
  --port <n>              Port for --serve (default ${DEFAULT_REPLAY_PORT}; 0 = random)
  --allow-remote          Required to bind a non-loopback address with --serve
  --max-bytes <n>         Maximum recording size accepted (default ${DEFAULT_LIMITS.maxRecordingBytes})
  --json                  Print a JSON report after replaying locally
  --no-events             Do not print individual events
  -h, --help              Show this help

Exit codes (local replay): 0 replayed stream completed, 3 replayed stream did not complete.
`;

export async function runReplayCommand(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    {
      speed: { type: 'string' },
      'fixed-gap-ms': { type: 'string' },
      serve: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      'allow-remote': { type: 'boolean' },
      'max-bytes': { type: 'string' },
      json: { type: 'boolean' },
      'no-events': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    true,
  );
  if (values.help) {
    out(REPLAY_HELP);
    return EXIT.ok;
  }
  if (positionals.length !== 1) throw new UsageError('Expected exactly one recording file.');
  if (values.speed !== undefined && values['fixed-gap-ms'] !== undefined) {
    throw new UsageError('Use either --speed or --fixed-gap-ms, not both.');
  }
  const file = positionals[0]!;
  const maxBytes =
    intOption(values['max-bytes'], 'max-bytes', 1_024, 1024 * 1024 * 1024) ??
    DEFAULT_LIMITS.maxRecordingBytes;

  let info;
  try {
    info = await stat(file);
  } catch (error) {
    throw new CliError(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!info.isFile()) throw new CliError(`${file} is not a regular file.`);
  if (info.size > maxBytes)
    throw new CliError(`${file} is ${info.size} bytes; the limit is ${maxBytes} (--max-bytes).`);
  const parsed = parseRecording(await readFile(file, 'utf8'), maxBytes);
  if (!parsed.ok) throw new CliError(parsed.error);
  const recording = parsed.recording;

  const speed = numberOption(values.speed, 'speed', 0.01, 100);
  const gap = intOption(values['fixed-gap-ms'], 'fixed-gap-ms', 0, 60_000);
  const timing: ReplayTiming =
    speed !== undefined
      ? { kind: 'scaled', factor: speed }
      : gap !== undefined
        ? { kind: 'fixed', gapMs: gap }
        : { kind: 'original' };

  if (values.serve) {
    const host = values.host ?? '127.0.0.1';
    if (!isLoopbackBindHost(host) && values['allow-remote'] !== true) {
      throw new UsageError(`Refusing to bind ${host} without --allow-remote.`);
    }
    const server = await startReplayServer({
      recording,
      timing,
      host,
      port: intOption(values.port, 'port', 0, 65_535) ?? DEFAULT_REPLAY_PORT,
    });
    out(
      `${style.green('●')} Replaying ${file} on ${style.bold(server.url)} (${server.plan.mode} mode, ${server.plan.steps.length} steps)`,
    );
    out(`  POST ${server.url}/v1/chat/completions`);
    err('Every request replays the recording from the start. Press Ctrl+C to stop.');
    return waitForShutdown(() => server.close());
  }

  const plan = createReplayPlan(recording, timing);
  const live = !values.json;
  const showEvents = live && !values['no-events'];
  if (live) {
    out(
      `${style.bold('Replay')} ${file}  ${style.dim(`recorded ${recording.recordedAt} · ${plan.mode} mode · payloads ${recording.payloads.included ? 'included' : 'redacted'}`)}`,
    );
    if (showEvents) out(eventHeader());
  }

  const inspector = new StreamInspector();
  const started = performance.now();
  const now = (): number => performance.now() - started;
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  try {
    const result = await runReplay(
      plan,
      {
        start: (status, headers) => void inspector.onHeaders(status, headers, now()),
        write: (bytes) => {
          const update = inspector.onChunk(bytes, now());
          if (showEvents) {
            for (const e of update.events) out(eventLine(e));
            for (const d of update.diagnostics) if (d.severity !== 'info') out(diagnosticLine(d));
          }
          return Promise.resolve();
        },
        finish: (mode) => {
          const kind =
            mode === 'end'
              ? 'replay-end'
              : (recording.session.termination?.kind ?? 'upstream-reset');
          inspector.onEnd({
            kind,
            atMs: now(),
            detail: mode === 'end' ? null : `replayed (mode=${mode})`,
          });
        },
      },
      controller.signal,
    );
    if (result === 'aborted') {
      inspector.onEnd({ kind: 'client-abort', atMs: now(), detail: 'interrupted' });
      return EXIT.interrupted;
    }
  } finally {
    process.off('SIGINT', onSignal);
  }
  const snapshot = inspector.snapshot();
  if (values.json) {
    json({
      file,
      mode: plan.mode,
      outcome: snapshot.outcome,
      termination: snapshot.termination,
      metrics: snapshot.metrics,
      diagnostics: inspector.diagnostics,
    });
  } else {
    printSummary(snapshot, inspector.diagnostics);
  }
  return isFailureOutcome(snapshot) ? EXIT.streamFailure : EXIT.ok;
}
