import { useState } from 'react';
import type { ReplayTiming } from '@tokenfault/shared';
import { api } from '../api';
import { Badge, EmptyState, ErrorBanner, Section } from '../components/ui';
import { OUTCOME_LABEL, ms, outcomeTone, shortId, time } from '../format';
import type { LiveState } from '../live';
import type { Route } from '../router';

const MAX_FILE_BYTES = 32 * 1024 * 1024;

type TimingKind = ReplayTiming['kind'];

export function ReplayView({
  live,
  navigate,
}: {
  live: LiveState;
  navigate: (route: Route) => void;
}) {
  const [timingKind, setTimingKind] = useState<TimingKind>('original');
  const [factor, setFactor] = useState('2');
  const [gap, setGap] = useState('50');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const timing = (): ReplayTiming =>
    timingKind === 'scaled'
      ? { kind: 'scaled', factor: Number(factor) }
      : timingKind === 'fixed'
        ? { kind: 'fixed', gapMs: Number(gap) }
        : { kind: 'original' };

  const start = async (input: { sessionId?: string; recording?: unknown }): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.replay({ ...input, timing: timing() });
      navigate({ view: 'inspector', id: result.sessionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(`${file.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB.`);
      return;
    }
    let recording: unknown;
    try {
      recording = JSON.parse(await file.text());
    } catch {
      setError(`${file.name} is not valid JSON.`);
      return;
    }
    await start({ recording });
  };

  const replayable = live.sessions.filter((s) => s.termination !== null);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <p className="text-[12px] text-muted">
        Replay re-sends a recorded response timeline into a new session without contacting any
        model. It reproduces event order, timing and the way the stream ended; it does not
        regenerate a model response. Payload-free recordings replay redacted placeholders.
      </p>

      <Section title="Timing">
        <div
          className="flex flex-wrap items-end gap-4 p-3"
          role="radiogroup"
          aria-label="Replay timing"
        >
          {(
            [
              ['original', 'Original timing'],
              ['scaled', 'Speed factor'],
              ['fixed', 'Fixed gap'],
            ] as const
          ).map(([kind, label]) => (
            <label key={kind} className="flex items-center gap-1.5 text-[12px]">
              <input
                type="radio"
                name="timing"
                checked={timingKind === kind}
                onChange={() => setTimingKind(kind)}
              />
              {label}
            </label>
          ))}
          {timingKind === 'scaled' && (
            <label className="flex items-center gap-1.5 text-[12px]">
              ×
              <input
                className="input w-20 font-mono"
                value={factor}
                onChange={(e) => setFactor(e.target.value)}
                aria-label="Speed factor"
              />
              <span className="text-faint">(0.01–100; 2 = twice as fast)</span>
            </label>
          )}
          {timingKind === 'fixed' && (
            <label className="flex items-center gap-1.5 text-[12px]">
              <input
                className="input w-20 font-mono"
                value={gap}
                onChange={(e) => setGap(e.target.value.replace(/[^0-9]/g, ''))}
                aria-label="Gap in milliseconds"
              />
              ms between steps
            </label>
          )}
        </div>
      </Section>

      <Section title="Replay a captured session">
        {replayable.length === 0 ? (
          <EmptyState title="No finished sessions">
            Sessions held in memory can be replayed once they have ended.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {replayable.slice(0, 50).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-[12px]">
                <span className="font-mono">{shortId(s.id)}</span>
                <span className="font-mono text-faint">{time(s.startedAt)}</span>
                <Badge tone={outcomeTone(s.outcome)}>{OUTCOME_LABEL[s.outcome]}</Badge>
                {s.source === 'replay' && <Badge tone="info">replay</Badge>}
                {s.scenarioId && <Badge tone="warn">fault: {s.scenarioId}</Badge>}
                <span className="text-muted">
                  {s.metrics.eventCount} events · {ms(s.metrics.durationMs)}
                </span>
                <div className="ml-auto flex gap-1.5">
                  <a
                    className="btn"
                    href={api.recordingUrl(s.id, false)}
                    download={`tokenfault-${s.id}.tfrec.json`}
                  >
                    Export
                  </a>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void start({ sessionId: s.id })}
                    data-testid="replay-session"
                  >
                    Replay
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Replay a recording file">
        <div className="space-y-2 p-3 text-[12px]">
          <label className="flex flex-col gap-1.5">
            <span className="text-muted">
              Choose a .tfrec.json file exported by TokenFault (validated by the server, max 32
              MiB).
            </span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="text-[12px] file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-surface-2 file:px-2.5 file:py-1.5 file:text-fg"
            />
          </label>
        </div>
      </Section>
    </div>
  );
}
