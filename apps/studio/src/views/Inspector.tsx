import { useEffect, useMemo, useState } from 'react';
import type { SessionDetail } from '@tokenfault/shared';
import { api } from '../api';
import { Badge, EmptyState, ErrorBanner, Spinner, Stat, TabPanel, Tabs } from '../components/ui';
import { OUTCOME_LABEL, bytes, ms, outcomeTone, shortId } from '../format';
import type { LiveState } from '../live';
import type { Route } from '../router';
import { EventDetail } from '../inspector/EventDetail';
import { ChunkPanel, DiagnosticsPanel, FaultsPanel, ResponsePanel } from '../inspector/Panels';
import { SessionList } from '../inspector/SessionList';
import { Timeline } from '../inspector/Timeline';
import { VirtualList } from '../inspector/VirtualList';
import { eventStyle, eventSummary } from '../inspector/kinds';
import { useSessionDetail } from '../inspector/useSessionDetail';

interface Props {
  live: LiveState;
  selectedId: string | null;
  navigate: (route: Route) => void;
  onProbe: (scenarioId?: string) => Promise<void>;
  probing: boolean;
}

export function Inspector({ live, selectedId, navigate, onProbe, probing }: Props) {
  const id = selectedId ?? live.sessions[0]?.id ?? null;
  const state = useSessionDetail(id);

  return (
    <div className="grid h-[calc(100vh-88px)] min-h-[560px] grid-cols-[280px_1fr] gap-3 max-lg:grid-cols-1 max-lg:h-auto">
      <div className="panel min-h-0 overflow-hidden max-lg:h-72">
        <SessionList
          sessions={live.sessions}
          selectedId={id}
          onSelect={(sid) => navigate({ view: 'inspector', id: sid })}
        />
      </div>
      <div className="min-h-0 min-w-0">
        {id === null ? (
          <div className="panel h-full">
            <EmptyState
              title="No sessions to inspect"
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={probing}
                  onClick={() => void onProbe()}
                >
                  {probing ? 'Sending…' : 'Send a test request'}
                </button>
              }
            >
              Sessions appear here as soon as traffic flows through the proxy.
            </EmptyState>
          </div>
        ) : state.status === 'loading' || state.status === 'idle' ? (
          <div className="panel flex h-full items-center justify-center">
            <Spinner label="Loading session" />
          </div>
        ) : state.status === 'error' ? (
          <div className="panel p-4">
            <ErrorBanner error={state.message} />
          </div>
        ) : (
          <SessionView key={state.detail.id} detail={state.detail} />
        )}
      </div>
    </div>
  );
}

type Tab = 'events' | 'network' | 'response' | 'diagnostics' | 'faults';

function SessionView({ detail }: { detail: SessionDetail }) {
  const [tab, setTab] = useState<Tab>('events');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [includePayloads, setIncludePayloads] = useState(false);
  const [listHeight, setListHeight] = useState(360);
  const events = detail.events;
  const selectedIndex = useMemo(
    () => (selectedSeq === null ? null : events.findIndex((e) => e.seq === selectedSeq)),
    [events, selectedSeq],
  );
  const m = detail.metrics;
  const ended = detail.termination !== null;

  useEffect(() => {
    const update = (): void => setListHeight(Math.max(220, window.innerHeight - 520));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const tabs: readonly { id: Tab; label: string }[] = [
    { id: 'events', label: `Events (${m.eventCount})` },
    { id: 'network', label: `Network (${m.chunkCount})` },
    { id: 'response', label: 'Response' },
    { id: 'diagnostics', label: `Diagnostics (${detail.diagnostics.length})` },
    { id: 'faults', label: `Faults (${detail.annotations.length})` },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="session-view">
      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <span className="font-mono text-[13px] font-medium" title={detail.id}>
          {shortId(detail.id)}
        </span>
        <span className="font-mono text-[12px] text-muted">
          {detail.method} {detail.path}
        </span>
        <span className="font-mono text-[12px]">{detail.status ?? '—'}</span>
        <Badge tone={outcomeTone(detail.outcome)}>
          <span data-testid="session-outcome">{OUTCOME_LABEL[detail.outcome]}</span>
        </Badge>
        {detail.completionSignal && (
          <span className="text-[11px] text-faint">
            completion signal: {detail.completionSignal}
          </span>
        )}
        {detail.termination && (
          <span className="text-[12px] text-muted" data-testid="session-termination">
            termination <span className="font-mono text-fg">{detail.termination.kind}</span>
            {detail.termination.detail && (
              <span className="text-faint"> ({detail.termination.detail})</span>
            )}
            {detail.annotations.length > 0 && (
              <span className="text-warn"> · faults injected by TokenFault</span>
            )}
          </span>
        )}
        {detail.scenarioId && <Badge tone="warn">fault: {detail.scenarioId}</Badge>}
        {detail.source === 'replay' && (
          <Badge tone="info">replay of {shortId(detail.replayOf ?? '')}</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-[11.5px] text-muted"
            title="Prompts and request headers are never included."
          >
            <span className="sr-only">Prompts and request headers are never included.</span>
            <input
              type="checkbox"
              checked={includePayloads}
              onChange={(e) => setIncludePayloads(e.target.checked)}
              disabled={!detail.payloadCapture}
            />
            include response payloads
          </label>
          {ended ? (
            <a
              className="btn"
              href={api.recordingUrl(detail.id, includePayloads)}
              download={`tokenfault-${detail.id}.tfrec.json`}
              data-testid="export-recording"
            >
              Export recording
            </a>
          ) : (
            // A disabled link is still keyboard-activatable; a disabled button is not.
            <button
              type="button"
              className="btn opacity-50"
              disabled
              data-testid="export-recording"
            >
              Export recording
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
        <Stat label="Headers" value={ms(m.headersMs)} />
        <Stat label="First byte" value={ms(m.firstByteMs)} />
        <Stat label="First event" value={ms(m.firstEventMs)} />
        <Stat
          label="First delta"
          value={ms(m.firstContentMs)}
          hint="First event with content or tool-call data"
        />
        <Stat label="Duration" value={ms(m.durationMs)} />
        <Stat
          label="Max gap"
          value={ms(m.eventGaps?.maxMs ?? null)}
          hint={
            m.eventGaps ? `p50 ${ms(m.eventGaps.p50Ms)} · p95 ${ms(m.eventGaps.p95Ms)}` : undefined
          }
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
        <span>{m.eventCount} SSE events</span>
        <span>{m.contentDeltaCount} content deltas</span>
        <span>{m.toolCallDeltaCount} tool-call deltas</span>
        <span>
          {m.chunkCount} network chunks · {bytes(m.byteCount)}
        </span>
        <span>
          usage:{' '}
          {m.usage
            ? `${m.usage.promptTokens ?? '—'} / ${m.usage.completionTokens ?? '—'} / ${m.usage.totalTokens ?? '—'} (as reported in the stream, not measured${detail.source === 'replay' ? '; replayed' : ''})`
            : 'not reported'}
        </span>
        {detail.truncated && <span className="text-warn">capture truncated (limits reached)</span>}
        {!detail.payloadCapture && <span>payload capture disabled</span>}
      </div>

      <div className="panel px-1 py-1">
        <Timeline
          events={events}
          annotations={detail.annotations}
          headersMs={m.headersMs}
          termination={detail.termination}
          selectedSeq={selectedSeq}
          onSelect={setSelectedSeq}
        />
      </div>

      <div className="panel flex min-h-0 flex-1 flex-col">
        <Tabs
          idPrefix="session"
          label="Session data"
          className="flex gap-1 border-b border-line px-2 py-1.5"
          tabs={tabs}
          selected={tab}
          onSelect={setTab}
          tabClassName={(sel) =>
            `rounded px-2.5 py-1 text-[12px] ${sel ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg'}`
          }
        />
        <TabPanel idPrefix="session" selected={tab} className="min-h-0 flex-1">
          {tab === 'events' && (
            <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(320px,42%)] max-xl:grid-cols-1">
              <div className="min-w-0 border-r border-line">
                <div className="grid grid-cols-[52px_84px_76px_66px_1fr] border-b border-line px-3 py-1 text-[11px] text-muted">
                  <span>#</span>
                  <span>time</span>
                  <span>gap</span>
                  <span>kind</span>
                  <span>summary</span>
                </div>
                {events.length === 0 ? (
                  <EmptyState title={ended ? 'No SSE events' : 'Waiting for events…'}>
                    {ended ? 'The response did not contain any SSE events.' : undefined}
                  </EmptyState>
                ) : (
                  <VirtualList
                    items={events}
                    rowHeight={26}
                    height={listHeight}
                    selectedIndex={
                      selectedIndex !== null && selectedIndex >= 0 ? selectedIndex : null
                    }
                    onSelect={(i) => setSelectedSeq(events[i]?.seq ?? null)}
                    label="SSE events"
                    follow={!ended}
                    renderRow={(e, i, selected) => {
                      const st = eventStyle(e);
                      const gap = i > 0 ? e.atMs - events[i - 1]!.atMs : null;
                      return (
                        <div
                          data-testid="event-row"
                          className={`grid h-full cursor-pointer grid-cols-[52px_84px_76px_66px_1fr] items-center border-b border-line/40 px-3 font-mono text-[11.5px] ${selected ? 'bg-accent/15' : 'hover:bg-surface-2'}`}
                        >
                          <span className="text-muted">{e.seq}</span>
                          <span className="tabular-nums">{ms(e.atMs)}</span>
                          <span
                            className={`tabular-nums ${gap !== null && m.eventGaps && gap >= Math.max(200, m.eventGaps.p95Ms * 3) ? 'text-warn' : 'text-muted'}`}
                          >
                            {gap === null ? '—' : ms(gap)}
                            {gap !== null &&
                              m.eventGaps &&
                              gap >= Math.max(200, m.eventGaps.p95Ms * 3) && (
                                <span className="sr-only"> (long gap)</span>
                              )}
                          </span>
                          <span className={st.text}>{st.label}</span>
                          <span className="truncate">{eventSummary(e)}</span>
                        </div>
                      );
                    }}
                  />
                )}
              </div>
              <div className="min-h-0" style={{ height: listHeight + 24 }}>
                <EventDetail
                  event={
                    selectedIndex !== null && selectedIndex >= 0
                      ? (events[selectedIndex] ?? null)
                      : null
                  }
                  previous={
                    selectedIndex !== null && selectedIndex > 0
                      ? (events[selectedIndex - 1] ?? null)
                      : null
                  }
                />
              </div>
            </div>
          )}
          {tab === 'network' && <ChunkPanel chunks={detail.chunks} height={listHeight} />}
          {tab === 'response' && <ResponsePanel choices={detail.choices} />}
          {tab === 'diagnostics' && <DiagnosticsPanel diagnostics={detail.diagnostics} />}
          {tab === 'faults' && (
            <FaultsPanel annotations={detail.annotations} faults={detail.faults} />
          )}
        </TabPanel>
      </div>
    </div>
  );
}
