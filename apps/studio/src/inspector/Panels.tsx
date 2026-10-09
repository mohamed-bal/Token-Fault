import { useMemo } from 'react';
import type {
  AssembledChoice,
  CapturedChunk,
  Diagnostic,
  FaultAnnotation,
} from '@tokenfault/shared';
import { Badge, CopyButton, EmptyState } from '../components/ui';
import { JsonView } from '../components/JsonView';
import { ms } from '../format';
import { VirtualList } from './VirtualList';

const decoder = new TextDecoder('utf-8', { fatal: false });

function decodeChunk(b64: string): string {
  try {
    const binary = atob(b64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return decoder.decode(arr);
  } catch {
    return '(undecodable)';
  }
}

function visible(text: string): string {
  return text.replace(/\r/g, '␍').replace(/\n/g, '␊').replace(/\t/g, '␉');
}

export function ChunkPanel({
  chunks,
  height,
}: {
  chunks: readonly CapturedChunk[];
  height: number;
}) {
  const rows = useMemo(
    () =>
      chunks.map((c) => ({
        ...c,
        text: c.dataBase64 !== null ? visible(decodeChunk(c.dataBase64)) : null,
      })),
    [chunks],
  );
  if (chunks.length === 0) return <EmptyState title="No network chunks captured" />;
  return (
    <div>
      <div className="grid grid-cols-[56px_88px_72px_1fr] border-b border-line px-3 py-1 text-[11px] text-muted">
        <span>#</span>
        <span>time</span>
        <span>bytes</span>
        <span>
          bytes as text{' '}
          <span className="text-faint">
            (␍ CR · ␊ LF; a chunk is one network read, not one event)
          </span>
        </span>
      </div>
      <VirtualList
        items={rows}
        rowHeight={24}
        height={height}
        selectedIndex={null}
        onSelect={() => undefined}
        label="Network chunks"
        renderRow={(c) => (
          <div className="grid h-full grid-cols-[56px_88px_72px_1fr] items-center border-b border-line/40 px-3 font-mono text-[11.5px]">
            <span className="text-muted">{c.seq}</span>
            <span className="tabular-nums">{ms(c.atMs)}</span>
            <span className="tabular-nums text-muted">{c.byteLength}</span>
            <span className="truncate">
              {c.text ?? <span className="text-faint">not captured</span>}
            </span>
          </div>
        )}
      />
    </div>
  );
}

export function ResponsePanel({ choices }: { choices: readonly AssembledChoice[] }) {
  if (choices.length === 0)
    return (
      <EmptyState title="No assembled response">
        The stream carried no chat-completion choices.
      </EmptyState>
    );
  return (
    <div className="space-y-4 p-3">
      {choices.map((c) => (
        <div key={c.index} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="font-medium">choice {c.index}</span>
            {c.role && <Badge>{c.role}</Badge>}
            <Badge tone={c.finishReason ? 'ok' : 'warn'}>
              {c.finishReason ? `finish: ${c.finishReason}` : 'no finish_reason'}
            </Badge>
            <span className="text-muted">{c.contentLength} chars</span>
            {c.content && <CopyButton text={c.content} label="Copy content" />}
          </div>
          {c.contentLength > 0 && (
            <div
              className="rounded-md border border-line bg-bg p-3 text-[13px] whitespace-pre-wrap"
              data-testid="assembled-content"
            >
              {c.content ?? <span className="text-faint">Content not captured.</span>}
            </div>
          )}
          {c.refusal && (
            <div className="rounded-md border border-warn/40 bg-warn/5 p-2 text-[12px]">
              refusal: {c.refusal}
            </div>
          )}
          {c.toolCalls.map((t) => (
            <div
              key={t.index}
              className="space-y-1.5 rounded-md border border-tool/30 bg-tool/5 p-2.5"
            >
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-mono text-tool">{t.name ?? '(no name)'}</span>
                <span className="font-mono text-muted">{t.id ?? 'no id'}</span>
                <span className="text-muted">
                  {t.fragmentCount} fragments · {t.argumentsLength} chars
                </span>
                {t.argumentsValidJson === true && <Badge tone="ok">valid JSON</Badge>}
                {t.argumentsValidJson === false && <Badge tone="err">invalid JSON</Badge>}
                {t.argumentsValidJson === null && <Badge>not checked</Badge>}
              </div>
              {t.arguments !== null ? (
                <JsonView text={t.arguments} />
              ) : (
                <div className="text-[12px] text-faint">Arguments not captured.</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DiagnosticsPanel({ diagnostics }: { diagnostics: readonly Diagnostic[] }) {
  if (diagnostics.length === 0)
    return (
      <EmptyState title="No diagnostics">
        The stream followed the SSE and chat-completions rules TokenFault checks.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-line">
      {diagnostics.map((d, i) => (
        <li key={i} className="flex flex-wrap items-start gap-2 px-3 py-2 text-[12px]">
          <Badge
            tone={d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'muted'}
          >
            {d.severity}
          </Badge>
          <span className="font-mono">{d.code}</span>
          {d.eventSeq !== null && <span className="text-muted">event #{d.eventSeq}</span>}
          {d.atMs !== null && <span className="text-faint">+{ms(d.atMs)}</span>}
          <div className="w-full text-muted">{d.message}</div>
        </li>
      ))}
    </ul>
  );
}

export function FaultsPanel({
  annotations,
  faults,
}: {
  annotations: readonly FaultAnnotation[];
  faults: readonly { type: string }[];
}) {
  return (
    <div className="space-y-3 p-3">
      {faults.length > 0 ? (
        <JsonView text={JSON.stringify(faults)} />
      ) : (
        <div className="text-[12px] text-muted">No faults were configured for this session.</div>
      )}
      {annotations.length > 0 && (
        <ul className="space-y-1.5" data-testid="fault-annotations">
          {annotations.map((a, i) => (
            <li key={i} className="rounded border border-warn/30 bg-warn/5 px-2 py-1.5 text-[12px]">
              <span className="font-mono text-warn">{a.faultType}</span>{' '}
              <span className="text-faint">+{ms(a.atMs)}</span>
              {a.afterEvents !== null && (
                <span className="text-faint"> · after {a.afterEvents} events</span>
              )}
              <div className="text-muted">{a.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
