import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Tone } from '../format';

const TONE: Record<Tone, string> = {
  ok: 'border-ok/30 bg-ok/10 text-ok',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  err: 'border-err/30 bg-err/10 text-err',
  info: 'border-info/30 bg-info/10 text-info',
  muted: 'border-line-strong bg-surface-2 text-muted',
};

export function Badge({
  tone = 'muted',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const color = { ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', info: 'bg-info', muted: 'bg-faint' }[
    tone
  ];
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string | undefined;
}) {
  return (
    <div className="panel px-3 py-2.5" title={hint}>
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-[17px] font-medium text-fg tabular-nums">{value}</div>
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  className = '',
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel flex min-h-0 flex-col ${className}`} aria-label={title}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="text-[12px] font-semibold text-fg">{title}</h2>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {children && <div className="max-w-md text-[12px] text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err"
    >
      <span>{error}</span>
      {onDismiss && (
        <button
          type="button"
          className="text-err/80 hover:text-err"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <span
        aria-hidden
        className="size-3 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
      <span className="text-[12px]">{label}…</span>
    </span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button type="button" className="btn px-2 py-1" onClick={() => void copy()} aria-live="polite">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

export function KeyValue({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 font-mono break-all text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
