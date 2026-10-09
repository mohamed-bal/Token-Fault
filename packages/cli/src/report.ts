/**
 * Human-readable rendering of inspected streams, shared by `inspect` and `replay`.
 * All untrusted text (stream content, error messages) passes through
 * `sanitizeForTerminal` before it is printed.
 */
import type { InspectorSnapshot } from '@tokenfault/core';
import type { CapturedEvent, Diagnostic } from '@tokenfault/shared';
import { formatBytes, formatMs, out, sanitizeForTerminal, style } from './output.js';

export function eventLine(e: CapturedEvent): string {
  const i = e.interpretation;
  let detail: string;
  switch (i.kind) {
    case 'done':
      detail = style.green('[DONE]');
      break;
    case 'error':
      detail = style.red(`error: ${sanitizeForTerminal(i.error?.message ?? '', 100)}`);
      break;
    case 'invalid-json':
      detail = style.red(`invalid JSON: ${sanitizeForTerminal(e.data ?? '[redacted]', 80)}`);
      break;
    case 'unrecognized':
      detail = style.yellow(`unrecognized payload (${i.unknownKeys.join(', ') || 'no keys'})`);
      break;
    case 'chunk': {
      const parts: string[] = [];
      if (i.roles.length > 0) parts.push(`role=${i.roles.join(',')}`);
      if (i.content !== null && i.contentLength > 0)
        parts.push(JSON.stringify(sanitizeForTerminal(i.content, 60)));
      else if (i.contentLength > 0) parts.push(`content(${i.contentLength} chars, redacted)`);
      for (const tc of i.toolCalls) {
        const head = [tc.id, tc.name].filter((v) => v !== null).join(' ');
        parts.push(
          style.cyan(
            `tool[${tc.index}]${head ? ` ${sanitizeForTerminal(head, 40)}` : ''} +${tc.argumentsFragmentLength} chars`,
          ),
        );
      }
      for (const f of i.finishReasons) parts.push(style.yellow(`finish=${f.reason}`));
      if (i.usage) parts.push(style.dim(`usage=${JSON.stringify(i.usage)}`));
      detail = parts.join(' ') || style.dim('(empty delta)');
    }
  }
  const type = e.event === 'message' ? '' : style.dim(` event=${sanitizeForTerminal(e.event, 20)}`);
  return `  ${String(e.seq).padStart(4)}  ${formatMs(e.atMs).padStart(10)}  ${i.kind.padEnd(12)} ${detail}${type}`;
}

export function eventHeader(): string {
  return style.dim(`  ${'seq'.padStart(4)}  ${'+time'.padStart(10)}  ${'kind'.padEnd(12)} detail`);
}

export function diagnosticLine(d: Diagnostic): string {
  const sev =
    d.severity === 'error'
      ? style.red('error  ')
      : d.severity === 'warning'
        ? style.yellow('warning')
        : style.dim('info   ');
  const where = d.eventSeq !== null ? style.dim(` (event ${d.eventSeq})`) : '';
  return `  ${sev} ${d.code}${where}: ${sanitizeForTerminal(d.message, 160)}`;
}

export function printSummary(
  snapshot: InspectorSnapshot,
  diagnostics: readonly Diagnostic[],
): void {
  const m = snapshot.metrics;
  out();
  out(style.bold('Metrics') + style.dim('  (measured; SSE events and deltas are not tokens)'));
  out(`  headers      ${formatMs(m.headersMs)}`);
  out(`  first byte   ${formatMs(m.firstByteMs)}`);
  out(`  first event  ${formatMs(m.firstEventMs)}`);
  out(`  first delta  ${formatMs(m.firstContentMs)}`);
  out(`  duration     ${formatMs(m.durationMs)}`);
  out(
    `  events       ${m.eventCount}   content deltas ${m.contentDeltaCount}   tool-call deltas ${m.toolCallDeltaCount}`,
  );
  out(`  network      ${m.chunkCount} chunks, ${formatBytes(m.byteCount)}`);
  if (m.eventGaps) {
    const g = m.eventGaps;
    out(
      `  event gaps   p50 ${formatMs(g.p50Ms)} · p95 ${formatMs(g.p95Ms)} · max ${formatMs(g.maxMs)} · mean ${formatMs(g.meanMs)}`,
    );
  }
  out(
    `  usage        ${m.usage ? `${JSON.stringify(m.usage)} ${style.dim('(reported by API)')}` : style.dim('not reported by API')}`,
  );
  const outcome = snapshot.outcome;
  const color = outcome === 'completed' || outcome === 'non-stream' ? style.green : style.red;
  out();
  out(
    `${style.bold('Outcome')}  ${color(outcome)}${snapshot.completionSignal ? style.dim(` (${snapshot.completionSignal})`) : ''}` +
      `  status ${snapshot.status ?? '—'}  termination ${snapshot.termination?.kind ?? '—'}` +
      (snapshot.termination?.detail
        ? style.dim(` (${sanitizeForTerminal(snapshot.termination.detail, 80)})`)
        : ''),
  );
  for (const choice of snapshot.choices) {
    for (const call of choice.toolCalls) {
      out(
        `  tool call ${call.index}: ${sanitizeForTerminal(call.name ?? '(no name)', 40)} · ${call.fragmentCount} fragments · ${call.argumentsLength} chars · ` +
          (call.argumentsValidJson === null
            ? 'JSON not checked'
            : call.argumentsValidJson
              ? style.green('valid JSON')
              : style.red('INVALID JSON')),
      );
    }
  }
  if (diagnostics.length > 0) {
    out();
    out(style.bold(`Diagnostics (${diagnostics.length})`));
    for (const d of diagnostics) out(diagnosticLine(d));
  }
  if (snapshot.truncated)
    out(style.dim('\n  Some data was not captured because a capture limit was reached.'));
}

export function isFailureOutcome(snapshot: InspectorSnapshot): boolean {
  return snapshot.outcome !== 'completed' && snapshot.outcome !== 'non-stream';
}
