import type { ActiveFaults, ServerInfo } from '@tokenfault/shared';
import { Badge, EmptyState, KeyValue, Section, Stat } from '../components/ui';
import { OUTCOME_LABEL, isFailure, median, ms, outcomeTone, shortId, time } from '../format';
import type { LiveState } from '../live';
import type { Route } from '../router';

interface Props {
  live: LiveState;
  info: ServerInfo | null;
  activeFaults: ActiveFaults | null;
  onProbe: (scenarioId?: string) => Promise<void>;
  probing: boolean;
  navigate: (route: Route) => void;
}

export function Overview({ live, info, activeFaults, onProbe, probing, navigate }: Props) {
  const sessions = live.sessions;
  const ended = sessions.filter((s) => s.termination !== null);
  const failing = sessions.filter(isFailure).length;
  const streaming = sessions.filter((s) => s.termination === null).length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Sessions"
          value={sessions.length}
          hint="Sessions held in memory on the server (bounded)."
        />
        <Stat label="Streaming" value={streaming} />
        <Stat label="Completed" value={sessions.filter((s) => s.outcome === 'completed').length} />
        <Stat
          label="Failed"
          value={<span className={failing > 0 ? 'text-err' : ''}>{failing}</span>}
          hint="Incomplete streams, in-stream errors and HTTP errors."
        />
        <Stat
          label="Median first byte"
          value={ms(median(ended.map((s) => s.metrics.firstByteMs)))}
          hint="Across sessions currently listed. Measured, not estimated."
        />
        <Stat
          label="Median first delta"
          value={ms(median(ended.map((s) => s.metrics.firstContentMs)))}
          hint="Time to the first content or tool-call delta."
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Section
          title="Recent sessions"
          actions={
            sessions.length > 0 ? (
              <a className="text-[12px] text-accent hover:underline" href="#/inspector">
                Open inspector →
              </a>
            ) : undefined
          }
        >
          {sessions.length === 0 ? (
            <EmptyState
              title="No sessions yet"
              action={
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={probing}
                  onClick={() => void onProbe()}
                >
                  {probing ? 'Sending…' : 'Send a test request through the proxy'}
                </button>
              }
            >
              Point your application's OpenAI-compatible base URL at this proxy, or send a test
              request. With <code className="font-mono">tokenfault proxy --mock</code> no API key is
              needed.
            </EmptyState>
          ) : (
            <table className="w-full text-left text-[12px]">
              <thead className="text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-1.5 font-medium">Started</th>
                  <th className="px-3 py-1.5 font-medium">Session</th>
                  <th className="px-3 py-1.5 font-medium">Status</th>
                  <th className="px-3 py-1.5 font-medium">Outcome</th>
                  <th className="px-3 py-1.5 text-right font-medium">First byte</th>
                  <th className="px-3 py-1.5 text-right font-medium">Events</th>
                  <th className="px-3 py-1.5 font-medium">Scenario</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 12).map((s) => (
                  <tr
                    key={s.id}
                    className="cursor-pointer border-b border-line/60 hover:bg-surface-2"
                    onClick={() => navigate({ view: 'inspector', id: s.id })}
                  >
                    <td className="px-3 py-1.5 font-mono text-muted">{time(s.startedAt)}</td>
                    <td className="px-3 py-1.5 font-mono">
                      <a
                        href={`#/inspector/${s.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {shortId(s.id)}
                      </a>
                      {s.source === 'replay' && <Badge tone="info">replay</Badge>}
                    </td>
                    <td className="px-3 py-1.5 font-mono">{s.status ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone={outcomeTone(s.outcome)}>{OUTCOME_LABEL[s.outcome]}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {ms(s.metrics.firstByteMs)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {s.metrics.eventCount}
                    </td>
                    <td className="px-3 py-1.5 text-muted">
                      {s.scenarioId ?? (s.faults.length > 0 ? 'custom' : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Server">
          <div className="space-y-3 p-3">
            {info ? (
              <KeyValue
                rows={[
                  ['target', info.target],
                  ['payloads', info.payloadCapture ? 'captured in memory' : 'not captured'],
                  [
                    'recording',
                    info.recording.enabled
                      ? `on (${info.recording.includePayloads ? 'with' : 'without'} payloads)`
                      : 'off',
                  ],
                  [
                    'faults',
                    activeFaults
                      ? (activeFaults.scenarioId ?? `${activeFaults.faults.length} custom`)
                      : 'none',
                  ],
                  [
                    'limits',
                    `${info.limits.maxSessions} sessions · ${info.limits.maxEventsPerSession.toLocaleString()} events each`,
                  ],
                ]}
              />
            ) : (
              <div className="text-[12px] text-muted">Loading server information…</div>
            )}
            <p className="text-[11px] leading-relaxed text-faint">
              Request headers and prompts are never captured. Metrics are measured from real I/O;
              SSE events and content deltas are not tokens, and token usage is shown only when the
              API reports it.
            </p>
          </div>
        </Section>
      </div>
    </div>
  );
}
