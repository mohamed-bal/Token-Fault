import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { createRecording, serializeRecording, sessionDetail } from '@tokenfault/core';
import { streamRequest } from '@tokenfault/core/node';
import { startMockLlm } from '@tokenfault/mock-llm';
import type { RunningMockLlm } from '@tokenfault/mock-llm';
import {
  DEFAULT_PROXY_PORT,
  FAULTS_HEADER,
  SCENARIO_HEADER,
  isSensitiveHeader,
  redactPathQuery,
} from '@tokenfault/shared';
import { intOption, parse } from '../args.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { cliVersion } from '../meta.js';
import { err, json, out, sanitizeForTerminal, style, warn } from '../output.js';
import {
  eventHeader,
  eventLine,
  diagnosticLine,
  isFailureOutcome,
  printSummary,
} from '../report.js';

export const INSPECT_HELP = `Usage: tokenfault inspect [options]

Send one streaming chat-completions request and show every SSE event as it
arrives, then measured timing metrics, the protocol outcome and diagnostics.

Target:
  --url <url>             Endpoint URL (default http://127.0.0.1:${DEFAULT_PROXY_PORT}/v1/chat/completions,
                          i.e. a running \`tokenfault proxy\`)
  --mock                  Start an embedded mock LLM and inspect it directly

Request:
  --prompt <text>         User message (default: a short test prompt)
  --model <name>          Model name (default tokenfault-mock-1)
  --body <json>           Full JSON request body (overrides --prompt/--model)
  --body-file <path>      Read the JSON request body from a file
  --scenario <id>         Send x-tokenfault-scenario (honoured by the proxy and the mock)
  --faults <json>         Send x-tokenfault-faults
  --header <k: v>         Extra request header (repeatable)
  --api-key-env <NAME>    Read the API key from environment variable NAME and send it as a
                          Bearer token. Keys are never accepted as command-line values.
  --timeout-ms <n>        Abort after n ms (default 120000)

Output:
  --json                  Print a JSON report instead of the live view
  --no-events             Do not print individual events
  --record <path>         Save a recording of the response (refuses to overwrite)
  --record-payloads       Include response payloads in the recording (off by default)
  -h, --help              Show this help

Exit codes: 0 stream completed, 1 error, 2 usage error, 3 stream did not complete
(HTTP error, incomplete stream, in-stream error).
`;

function recordingExists(file: string): string {
  return `Recording file already exists: ${file}. Recordings are never overwritten; choose another path or delete the file.`;
}

export async function runInspect(argv: readonly string[]): Promise<number> {
  const { values } = parse(argv, {
    url: { type: 'string' },
    mock: { type: 'boolean' },
    prompt: { type: 'string' },
    model: { type: 'string' },
    body: { type: 'string' },
    'body-file': { type: 'string' },
    scenario: { type: 'string' },
    faults: { type: 'string' },
    header: { type: 'string', multiple: true },
    'api-key-env': { type: 'string' },
    'timeout-ms': { type: 'string' },
    json: { type: 'boolean' },
    'no-events': { type: 'boolean' },
    record: { type: 'string' },
    'record-payloads': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(INSPECT_HELP);
    return EXIT.ok;
  }
  if (values.url && values.mock) throw new UsageError('Use either --url or --mock, not both.');
  if (values.body && values['body-file'])
    throw new UsageError('Use either --body or --body-file, not both.');
  if (values['record-payloads'] && !values.record)
    throw new UsageError('--record-payloads requires --record <path>.');
  // Fail before contacting the upstream; the write below still uses 'wx' against races.
  if (values.record && existsSync(values.record))
    throw new CliError(recordingExists(values.record));

  const headers: OutgoingHttpHeaders = { accept: 'text/event-stream' };
  for (const raw of values.header ?? []) {
    const colon = raw.indexOf(':');
    if (colon <= 0) throw new UsageError(`--header must look like "name: value", got "${raw}"`);
    const name = raw.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name))
      throw new UsageError(`Invalid header name "${name}"`);
    if (isSensitiveHeader(name)) {
      warn(
        `header "${name}" was passed on the command line, where it may end up in shell history; prefer --api-key-env.`,
      );
    }
    headers[name] = raw.slice(colon + 1).trim();
  }
  if (values['api-key-env']) {
    const key = process.env[values['api-key-env']];
    if (!key)
      throw new UsageError(`Environment variable ${values['api-key-env']} is not set or empty.`);
    headers['authorization'] = `Bearer ${key}`;
  }
  if (values.scenario) headers[SCENARIO_HEADER] = values.scenario;
  if (values.faults) headers[FAULTS_HEADER] = values.faults;

  let body: string;
  if (values.body || values['body-file']) {
    body =
      values.body ??
      (await readFile(values['body-file'] ?? '', 'utf8').catch((e: unknown) => {
        throw new CliError(
          `Cannot read --body-file: ${e instanceof Error ? e.message : String(e)}`,
        );
      }));
    try {
      JSON.parse(body);
    } catch {
      throw new UsageError('The request body is not valid JSON.');
    }
  } else {
    body = JSON.stringify({
      model: values.model ?? 'tokenfault-mock-1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: values.prompt ?? 'Hello from tokenfault inspect.' }],
    });
  }
  headers['content-type'] = 'application/json';

  let mock: RunningMockLlm | null = null;
  let url = values.url ?? `http://127.0.0.1:${DEFAULT_PROXY_PORT}/v1/chat/completions`;
  if (values.mock) {
    mock = await startMockLlm({ port: 0 });
    url = `${mock.url}/v1/chat/completions`;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UsageError(`Invalid --url "${url}"`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
    throw new UsageError('--url must be http or https.');
  if (parsedUrl.username || parsedUrl.password)
    throw new UsageError('--url must not contain credentials.');

  const live = !values.json;
  const showEvents = live && !values['no-events'];
  const displayUrl = `${parsedUrl.origin}${redactPathQuery(parsedUrl.pathname + parsedUrl.search)}`;
  if (live) out(`${style.bold('POST')} ${displayUrl}`);

  try {
    const result = await streamRequest(parsedUrl, {
      method: 'POST',
      headers,
      body,
      timeoutMs: intOption(values['timeout-ms'], 'timeout-ms', 100, 3_600_000) ?? 120_000,
      onHeaders: (status, h, atMs) => {
        if (!live) return;
        const session = h['x-tokenfault-session'];
        out(
          `${status < 400 ? style.green(String(status)) : style.red(String(status))} ${sanitizeForTerminal(String(h['content-type'] ?? ''), 60)} after ${atMs.toFixed(1)} ms` +
            (typeof session === 'string' ? style.dim(`  session ${session}`) : ''),
        );
        if (showEvents) out(eventHeader());
      },
      onUpdate: (update) => {
        if (!showEvents) return;
        for (const e of update.events) out(eventLine(e));
        for (const d of update.diagnostics) if (d.severity !== 'info') out(diagnosticLine(d));
      },
    });

    if (result.termination.kind === 'upstream-unreachable') {
      throw new CliError(
        `Could not connect to ${displayUrl}: ${result.termination.detail ?? 'unknown error'}${values.url || values.mock ? '' : ' (is `tokenfault proxy` running?)'}`,
      );
    }

    if (values.record) {
      const sessionHeader = result.headers['x-tokenfault-session'];
      const detail = sessionDetail(
        {
          id:
            typeof sessionHeader === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sessionHeader)
              ? sessionHeader
              : randomUUID(),
          source: 'proxy',
          startedAt: new Date(Date.now() - (result.termination.atMs ?? 0)).toISOString(),
          method: 'POST',
          path: redactPathQuery(parsedUrl.pathname + parsedUrl.search),
          scenarioId: values.scenario ?? null,
          faults: [],
          request: {
            model: null,
            stream: true,
            messageCount: null,
            toolCount: null,
            bodyBytes: Buffer.byteLength(body),
          },
          replayOf: null,
        },
        result.inspector,
        [],
      );
      const recording = createRecording(detail, {
        includePayloads: values['record-payloads'] === true,
        toolVersion: cliVersion(),
        seed: null,
      });
      try {
        await writeFile(values.record, serializeRecording(recording), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new CliError(recordingExists(values.record));
        throw new CliError(
          `Cannot write recording: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (live)
        err(
          `Recording written to ${values.record} (${recording.payloads.included ? 'with' : 'without'} payloads).`,
        );
    }

    if (values.json) {
      json({
        url: displayUrl,
        status: result.status,
        outcome: result.snapshot.outcome,
        completionSignal: result.snapshot.completionSignal,
        termination: result.termination,
        metrics: result.snapshot.metrics,
        choices: result.snapshot.choices,
        diagnostics: result.diagnostics,
        events: result.events,
      });
    } else {
      printSummary(result.snapshot, result.diagnostics);
    }
    return isFailureOutcome(result.snapshot) ? EXIT.streamFailure : EXIT.ok;
  } finally {
    await mock?.close();
  }
}
