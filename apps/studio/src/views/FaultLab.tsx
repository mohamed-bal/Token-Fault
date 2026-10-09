import { useEffect, useState } from 'react';
import type { ActiveFaults, FaultTypeDescriptor, ScenarioDescriptor } from '@tokenfault/shared';
import { api } from '../api';
import { Badge, ErrorBanner, Section, Spinner } from '../components/ui';
import { JsonView } from '../components/JsonView';

interface Props {
  activeFaults: ActiveFaults | null;
  onProbe: (scenarioId?: string, withTools?: boolean) => Promise<void>;
  probing: boolean;
}

type ParamValues = Record<string, string>;
interface DraftFault {
  readonly key: number;
  readonly type: string;
  readonly values: ParamValues;
}

export function FaultLab({ activeFaults, onProbe, probing }: Props) {
  const [catalog, setCatalog] = useState<{
    scenarios: ScenarioDescriptor[];
    faultTypes: FaultTypeDescriptor[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<DraftFault[]>([]);
  const [seed, setSeed] = useState('1');
  const [nextKey, setNextKey] = useState(1);
  const [addType, setAddType] = useState('');

  useEffect(() => {
    api
      .scenarios()
      .then((c) => {
        setCatalog(c);
        setAddType(c.faultTypes.find((f) => f.appliesTo.includes('proxy'))?.type ?? '');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!catalog)
    return error ? <ErrorBanner error={error} /> : <Spinner label="Loading scenarios" />;
  const proxyTypes = catalog.faultTypes.filter((f) => f.appliesTo.includes('proxy'));

  const buildProfile = (): { faults: Record<string, unknown>[]; seed: number } => ({
    seed: Number(seed),
    faults: drafts.map((d) => {
      const descriptor = catalog.faultTypes.find((f) => f.type === d.type);
      const fault: Record<string, unknown> = { type: d.type };
      for (const p of descriptor?.params ?? []) {
        const raw = d.values[p.name] ?? '';
        if (raw === '') continue;
        fault[p.name] =
          p.kind === 'integer' ? Number(raw) : p.kind === 'boolean' ? raw === 'true' : raw;
      }
      return fault;
    }),
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      <Section
        title="Active server-wide faults"
        actions={
          activeFaults && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void act(() => api.clearFaults())}
              data-testid="clear-faults"
            >
              Clear
            </button>
          )
        }
      >
        <div className="p-3 text-[12px]" data-testid="active-faults" aria-live="polite">
          {activeFaults ? (
            <div className="space-y-2">
              <div>
                Every request through the proxy currently gets{' '}
                <span className="font-mono text-warn">
                  {activeFaults.scenarioId ?? 'a custom profile'}
                </span>{' '}
                (seed {activeFaults.seed}). A single request can opt out with{' '}
                <code className="font-mono">x-tokenfault-scenario: none</code>.
              </div>
              <JsonView text={JSON.stringify(activeFaults.faults)} />
            </div>
          ) : (
            <span className="text-muted">
              None. Requests pass through unchanged unless they select a scenario themselves.
            </span>
          )}
        </div>
      </Section>

      <Section title="Scenarios">
        <div className="grid gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
          {catalog.scenarios.map((s) => {
            const proxyOk = s.appliesTo.includes('proxy');
            return (
              <article
                key={s.id}
                className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3"
                data-testid={`scenario-${s.id}`}
              >
                <header className="flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded bg-surface-3 font-mono text-[12px] text-accent-strong">
                    {s.letter}
                  </span>
                  <h3 className="text-[13px] font-semibold">{s.title}</h3>
                  {!proxyOk && <Badge tone="info">mock only</Badge>}
                </header>
                <p className="text-[12px] text-muted">{s.description}</p>
                <p className="text-[11.5px] text-faint">
                  <span className="text-muted">Expected:</span> {s.expectedBehavior}
                </p>
                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={probing}
                    onClick={() => void onProbe(s.id, s.id === 'fragmented-tool-calls')}
                    data-testid={`run-${s.id}`}
                  >
                    Run test request
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !proxyOk}
                    onClick={() => void act(() => api.setScenario(s.id))}
                    title={
                      proxyOk
                        ? 'Apply to every proxied request'
                        : 'This scenario shapes generated content and only works on the mock server (tokenfault mock --scenario ...).'
                    }
                  >
                    Apply to all requests
                  </button>
                </div>
                {!proxyOk && (
                  <p className="text-[11px] text-faint">
                    Shapes generated content, so it only works on the mock server (
                    <code className="font-mono">tokenfault mock --scenario {s.id}</code>).
                  </p>
                )}
              </article>
            );
          })}
        </div>
        <p className="px-3 pb-3 text-[11.5px] text-faint">
          “Run test request” sends one streaming request through this proxy with{' '}
          <code className="font-mono">x-tokenfault-scenario</code>. Mock-only scenarios only take
          effect when the target is the TokenFault mock server.
        </p>
      </Section>

      <Section title="Custom fault profile">
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="label">fault type</span>
              <select
                className="input"
                value={addType}
                onChange={(e) => setAddType(e.target.value)}
              >
                {proxyTypes.map((f) => (
                  <option
                    key={f.type}
                    value={f.type}
                    disabled={drafts.some((d) => d.type === f.type)}
                  >
                    {f.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={!addType || drafts.some((d) => d.type === addType)}
              onClick={() => {
                setDrafts([...drafts, { key: nextKey, type: addType, values: {} }]);
                setNextKey(nextKey + 1);
              }}
            >
              Add fault
            </button>
            <label className="ml-auto flex flex-col gap-1">
              <span className="label">seed</span>
              <input
                className="input w-28 font-mono"
                inputMode="numeric"
                value={seed}
                onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </label>
          </div>

          {drafts.length === 0 && (
            <div className="text-[12px] text-muted">
              Add one or more faults. Each fault type can appear once; the server validates every
              value.
            </div>
          )}

          {drafts.map((d) => {
            const descriptor = catalog.faultTypes.find((f) => f.type === d.type);
            if (!descriptor) return null;
            return (
              <fieldset key={d.key} className="rounded-lg border border-line bg-surface-2 p-3">
                <legend className="px-1 text-[12px] font-semibold">{descriptor.title}</legend>
                <p className="mb-2 text-[11.5px] text-muted">{descriptor.description}</p>
                <div className="flex flex-wrap gap-3">
                  {descriptor.params.map((p) => (
                    <label key={p.name} className="flex flex-col gap-1" title={p.description}>
                      <span className="label">
                        {p.name}
                        {p.unit ? ` (${p.unit})` : ''}
                        {p.optional ? ' · optional' : ''}
                      </span>
                      <span className="sr-only">{p.description}</span>
                      {p.kind === 'enum' ? (
                        <select
                          className="input"
                          value={d.values[p.name] ?? ''}
                          onChange={(e) =>
                            setDrafts(
                              drafts.map((x) =>
                                x.key === d.key
                                  ? { ...x, values: { ...x.values, [p.name]: e.target.value } }
                                  : x,
                              ),
                            )
                          }
                        >
                          <option value="">{p.optional ? '(omit)' : '(default)'}</option>
                          {(p.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="input w-32 font-mono"
                          inputMode="numeric"
                          placeholder={
                            p.min !== undefined && p.max !== undefined ? `${p.min}–${p.max}` : ''
                          }
                          value={d.values[p.name] ?? ''}
                          onChange={(e) =>
                            setDrafts(
                              drafts.map((x) =>
                                x.key === d.key
                                  ? {
                                      ...x,
                                      values: {
                                        ...x.values,
                                        [p.name]: e.target.value.replace(/[^0-9]/g, ''),
                                      },
                                    }
                                  : x,
                              ),
                            )
                          }
                        />
                      )}
                    </label>
                  ))}
                  <button
                    type="button"
                    className="btn btn-danger self-end"
                    onClick={() => setDrafts(drafts.filter((x) => x.key !== d.key))}
                  >
                    Remove
                  </button>
                </div>
              </fieldset>
            );
          })}

          {drafts.length > 0 && (
            <div className="space-y-2">
              <JsonView text={JSON.stringify(buildProfile())} />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || seed === ''}
                onClick={() => void act(() => api.setProfile(buildProfile()))}
              >
                Apply to all requests
              </button>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
