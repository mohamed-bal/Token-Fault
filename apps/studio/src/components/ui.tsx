import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
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
    <div className="panel px-3 py-2.5">
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-[17px] font-medium text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10.5px] leading-tight text-faint">{hint}</div>}
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
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-err/80 hover:text-err"
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

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
}

/**
 * WAI-ARIA tabs: roving tabindex, ←/→/Home/End move and activate, each tab controls
 * the panel rendered by `TabPanel` with the same `idPrefix`.
 */
export function Tabs<T extends string>({
  idPrefix,
  label,
  tabs,
  selected,
  onSelect,
  className = '',
  tabClassName,
}: {
  idPrefix: string;
  label: string;
  tabs: readonly TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
  className?: string;
  tabClassName: (selected: boolean) => string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent): void => {
    const index = tabs.findIndex((t) => t.id === selected);
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            if (el) refs.current.set(t.id, el);
            else refs.current.delete(t.id);
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={selected === t.id}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={selected === t.id ? 0 : -1}
          className={tabClassName(selected === t.id)}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  selected,
  className = '',
  children,
}: {
  idPrefix: string;
  selected: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel`}
      aria-labelledby={`${idPrefix}-tab-${selected}`}
      className={className}
    >
      {children}
    </div>
  );
}
