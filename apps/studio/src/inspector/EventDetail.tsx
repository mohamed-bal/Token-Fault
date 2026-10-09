import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CapturedEvent } from '@tokenfault/shared';
import { Badge, CopyButton, EmptyState, KeyValue } from '../components/ui';
import { JsonView } from '../components/JsonView';
import { bytes, ms } from '../format';
import { eventStyle } from './kinds';

type Tab = 'parsed' | 'raw' | 'diagnostics';

export function EventDetail({
  event,
  previous,
}: {
  event: CapturedEvent | null;
  previous: CapturedEvent | null;
}) {
  const [tab, setTab] = useState<Tab>('parsed');
  if (!event) {
    return (
      <EmptyState title="No event selected">
        Select an event in the list or on the timeline. Use ↑/↓ to step through events.
      </EmptyState>
    );
  }
  const i = event.interpretation;
  const style = eventStyle(event);
  const rawFrame = event.data === null ? null : buildRawFrame(event);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="event-detail">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-[12px] text-muted" data-testid="event-seq">
          #{event.seq}
        </span>
        <Badge tone={i.kind === 'chunk' ? 'info' : i.kind === 'done' ? 'ok' : 'err'}>
          {i.kind}
        </Badge>
        <span className={`text-[11px] ${style.text}`}>{style.label}</span>
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Event detail view">
          {(['parsed', 'raw', 'diagnostics'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`rounded px-2 py-0.5 text-[11.5px] ${tab === t ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'}`}
              onClick={() => setTab(t)}
            >
              {t === 'diagnostics' ? `diagnostics (${event.diagnostics.length})` : t}
            </button>
          ))}
        </div>
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {tab === 'parsed' && (
          <>
            <KeyValue
              rows={[
                ['time', `+${ms(event.atMs)}`],
                ['gap', previous ? ms(event.atMs - previous.atMs) : '—'],
                ['event type', event.event],
                ['id', event.id ?? '—'],
                ['retry', event.retry ?? '—'],
                ['data size', bytes(event.dataByteLength)],
                ['frame size', bytes(event.rawByteLength)],
              ]}
            />
            {i.kind === 'chunk' && (
              <div className="space-y-2">
                {i.roles.length > 0 && <Field label="role">{i.roles.join(', ')}</Field>}
                {i.contentLength > 0 && (
                  <Field label={`content delta (${i.contentLength} chars)`}>
                    {i.content !== null ? (
                      <span className="whitespace-pre-wrap">{i.content}</span>
                    ) : (
                      <span className="text-faint">not captured</span>
                    )}
                  </Field>
                )}
                {i.toolCalls.map((t) => (
                  <Field
                    key={`${t.choiceIndex}.${t.index}`}
                    label={`tool call ${t.index}${t.id ? ` · ${t.id}` : ''}${t.name ? ` · ${t.name}` : ''}`}
                  >
                    {t.argumentsFragment !== null ? (
                      <span className="whitespace-pre-wrap text-tool">
                        {t.argumentsFragment || '(empty fragment)'}
                      </span>
                    ) : (
                      <span className="text-faint">
                        {t.argumentsFragmentLength} chars, not captured
                      </span>
                    )}
                  </Field>
                ))}
                {i.finishReasons.map((f) => (
                  <Field key={f.choiceIndex} label={`finish_reason (choice ${f.choiceIndex})`}>
                    {f.reason}
                  </Field>
                ))}
                {i.usage && (
                  <Field label="usage (reported by API)">{`prompt ${i.usage.promptTokens ?? '—'} · completion ${i.usage.completionTokens ?? '—'} · total ${i.usage.totalTokens ?? '—'}`}</Field>
                )}
                {i.unknownKeys.length > 0 && (
                  <Field label="keys not modelled (kept in raw data)">
                    {i.unknownKeys.join(', ')}
                  </Field>
                )}
              </div>
            )}
            {i.error && (
              <Field
                label={`error${i.error.type ? ` · ${i.error.type}` : ''}${i.error.code ? ` · ${i.error.code}` : ''}`}
              >
                {i.error.message}
              </Field>
            )}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="label">data</span>
                {event.data !== null && <CopyButton text={event.data} label="Copy data" />}
              </div>
              {event.data !== null ? (
                <JsonView text={event.data} />
              ) : (
                <div className="text-[12px] text-faint">
                  Payload not captured (capture disabled or capture limit reached).
                </div>
              )}
            </div>
          </>
        )}
        {tab === 'raw' && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="label">reconstructed SSE frame</span>
              {rawFrame && <CopyButton text={rawFrame} label="Copy frame" />}
            </div>
            {rawFrame !== null ? (
              <pre className="mono scroll-thin overflow-auto rounded-md border border-line bg-bg p-2.5 whitespace-pre-wrap break-all">
                {visualizeLineEnds(rawFrame)}
              </pre>
            ) : (
              <div className="text-[12px] text-faint">Payload not captured.</div>
            )}
            <p className="text-[11px] text-faint">
              Rebuilt from the parsed fields. The exact bytes on the wire, including line endings
              and comments, are in the session's Network tab.
            </p>
          </div>
        )}
        {tab === 'diagnostics' &&
          (event.diagnostics.length === 0 ? (
            <div className="text-[12px] text-muted">No protocol diagnostics for this event.</div>
          ) : (
            <ul className="space-y-1.5">
              {event.diagnostics.map((d, idx) => (
                <li
                  key={idx}
                  className="rounded border border-line bg-surface-2 px-2 py-1.5 text-[12px]"
                >
                  <Badge
                    tone={
                      d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'muted'
                    }
                  >
                    {d.severity}
                  </Badge>{' '}
                  <span className="font-mono">{d.code}</span>
                  <div className="mt-0.5 text-muted">{d.message}</div>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="label mb-0.5">{label}</div>
      <div className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12px] break-all">
        {children}
      </div>
    </div>
  );
}

function buildRawFrame(e: CapturedEvent): string {
  let out = '';
  if (e.event !== 'message') out += `event: ${e.event}\n`;
  if (e.id !== null) out += `id: ${e.id}\n`;
  if (e.retry !== null) out += `retry: ${e.retry}\n`;
  for (const line of (e.data ?? '').split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

function visualizeLineEnds(text: string): string {
  return text.replace(/\n/g, '↵\n');
}
