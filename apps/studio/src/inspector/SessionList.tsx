import { useMemo, useState } from 'react';
import type { SessionSummary, StreamOutcome } from '@tokenfault/shared';
import { Badge, Dot } from '../components/ui';
import { OUTCOME_LABEL, ms, outcomeTone, shortId, time } from '../format';

type Filter = 'all' | 'failed' | 'completed' | 'streaming';

const MATCH: Record<Filter, (o: StreamOutcome) => boolean> = {
  all: () => true,
  failed: (o) => o === 'incomplete' || o === 'stream-error' || o === 'http-error',
  completed: (o) => o === 'completed' || o === 'non-stream',
  streaming: (o) => o === 'pending',
};

export function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: readonly SessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter(
      (s) =>
        MATCH[filter](s.outcome) &&
        (q === '' ||
          s.id.includes(q) ||
          s.path.toLowerCase().includes(q) ||
          (s.scenarioId ?? '').includes(q) ||
          String(s.status ?? '').includes(q)),
    );
  }, [sessions, filter, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line p-2">
        <input
          className="input w-full"
          type="search"
          placeholder="Filter by id, path, status, scenario"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter sessions"
        />
        <div className="flex gap-1" role="group" aria-label="Outcome filter">
          {(['all', 'failed', 'completed', 'streaming'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={`rounded px-2 py-0.5 text-[11px] ${filter === f ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <ul className="scroll-thin min-h-0 flex-1 overflow-auto" aria-label="Sessions">
        {shown.length === 0 && (
          <li className="px-3 py-6 text-center text-[12px] text-muted">No matching sessions.</li>
        )}
        {shown.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-current={s.id === selectedId ? 'true' : undefined}
              data-testid="session-row"
              className={`flex w-full flex-col gap-0.5 border-b border-line/60 px-3 py-2 text-left hover:bg-surface-2 ${s.id === selectedId ? 'bg-surface-3' : ''}`}
            >
              <div className="flex items-center gap-2">
                <Dot tone={outcomeTone(s.outcome)} />
                <span className="font-mono text-[12px]">{shortId(s.id)}</span>
                <span className="font-mono text-[11px] text-muted">{s.status ?? '—'}</span>
                <span className="ml-auto font-mono text-[11px] text-faint">
                  {time(s.startedAt)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 pl-4">
                <Badge tone={outcomeTone(s.outcome)}>{OUTCOME_LABEL[s.outcome]}</Badge>
                {s.source === 'replay' && <Badge tone="info">replay</Badge>}
                {s.scenarioId && <Badge tone="warn">{s.scenarioId}</Badge>}
                {!s.scenarioId && s.faults.length > 0 && <Badge tone="warn">custom faults</Badge>}
              </div>
              <div className="truncate pl-4 font-mono text-[11px] text-faint">
                {s.method} {s.path} · {s.metrics.eventCount} ev · {ms(s.metrics.durationMs)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
