/**
 * Renders untrusted JSON / text safely. Everything is rendered as React text
 * nodes (never `dangerouslySetInnerHTML`), so payload content cannot inject markup.
 */
import type { ReactNode } from 'react';

const MAX_RENDER_CHARS = 200_000;

function render(value: unknown, indent: number, key: string): ReactNode {
  const pad = '  '.repeat(indent);
  if (value === null) return <span className="text-faint">null</span>;
  if (typeof value === 'string') return <span className="text-ok">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="text-orange">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="text-tool">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return (
      <>
        {'[\n'}
        {value.map((v, i) => (
          <span key={`${key}.${i}`}>
            {pad}
            {'  '}
            {render(v, indent + 1, `${key}.${i}`)}
            {i < value.length - 1 ? ',\n' : '\n'}
          </span>
        ))}
        {pad}
        {']'}
      </>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return (
      <>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={`${key}.${k}`}>
            {pad}
            {'  '}
            <span className="text-accent-strong">{JSON.stringify(k)}</span>
            {': '}
            {render(v, indent + 1, `${key}.${k}`)}
            {i < entries.length - 1 ? ',\n' : '\n'}
          </span>
        ))}
        {pad}
        {'}'}
      </>
    );
  }
  // JSON.parse only yields the types handled above.
  return null;
}

export function JsonView({ text }: { text: string }) {
  let parsed: unknown;
  let isJson = false;
  if (text.length <= MAX_RENDER_CHARS) {
    try {
      parsed = JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  const shown =
    text.length > MAX_RENDER_CHARS
      ? `${text.slice(0, MAX_RENDER_CHARS)}\n… (${text.length - MAX_RENDER_CHARS} more characters)`
      : text;
  return (
    <pre className="mono scroll-thin overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-bg p-2.5 leading-relaxed text-fg">
      {isJson ? render(parsed, 0, 'root') : shown}
    </pre>
  );
}
