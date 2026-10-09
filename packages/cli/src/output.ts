/**
 * Terminal output helpers. Colour is used only on a TTY and never when
 * NO_COLOR is set (https://no-color.org). Human output goes to stdout, logs
 * and warnings go to stderr, so `--json` output stays machine-readable.
 */
import { redactSecrets } from '@tokenfault/shared';

const useColor = (stream: NodeJS.WriteStream): boolean =>
  stream.isTTY === true && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';

function paint(code: string, text: string, stream: NodeJS.WriteStream = process.stdout): string {
  return useColor(stream) ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const style = {
  bold: (t: string) => paint('1', t),
  dim: (t: string) => paint('2', t),
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  cyan: (t: string) => paint('36', t),
};

export function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function err(line: string): void {
  process.stderr.write(`${redactSecrets(line)}\n`);
}

export function warn(line: string): void {
  process.stderr.write(
    `${useColor(process.stderr) ? '\u001b[33mwarning\u001b[0m' : 'warning'}: ${redactSecrets(line)}\n`,
  );
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces control characters so untrusted stream content cannot inject terminal escape sequences. */
export function sanitizeForTerminal(text: string, max = 120): string {
  let outText = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) outText += '\\n';
    else if (code === 0x0d) outText += '\\r';
    else if (code === 0x09) outText += '\\t';
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0))
      outText += `\\x${code.toString(16).padStart(2, '0')}`;
    else outText += ch;
    if (outText.length >= max) return `${outText.slice(0, max)}…`;
  }
  return outText;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
