import { useCallback, useEffect, useState } from 'react';
import { SignIn } from './components/SignIn';
import type { ServerInfo } from '@tokenfault/shared';
import { api, ApiError, UNAUTHORIZED_EVENT } from './api';
import { Dot, ErrorBanner } from './components/ui';
import { useLive } from './live';
import { useRoute } from './router';
import type { View } from './router';
import { FaultLab } from './views/FaultLab';
import { Inspector } from './views/Inspector';
import { Overview } from './views/Overview';
import { ReplayView } from './views/Replay';

const NAV: readonly { view: View; label: string; hint: string }[] = [
  { view: 'overview', label: 'Overview', hint: 'Sessions and server status' },
  { view: 'inspector', label: 'Stream Inspector', hint: 'Events, timing and diagnostics' },
  { view: 'faults', label: 'Fault Lab', hint: 'Inject failures' },
  { view: 'replay', label: 'Replay', hint: 'Replay and import recordings' },
];

function Workspace({ onSignOut }: { onSignOut: (() => void) | null }) {
  const live = useLive();
  const [route, navigate] = useRoute();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .info()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [live.connection]);

  const activeFaults =
    live.activeFaults !== undefined ? live.activeFaults : (info?.activeFaults ?? null);

  const probe = useCallback(
    async (scenarioId?: string, withTools = false) => {
      setProbing(true);
      setError(null);
      try {
        const result = await api.probe({ ...(scenarioId ? { scenarioId } : {}), withTools });
        if (result.error) setError(`Test request failed: ${result.error}`);
        if (result.sessionId) navigate({ view: 'inspector', id: result.sessionId });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setProbing(false);
      }
    },
    [navigate],
  );

  return (
    <div className="grid h-full grid-cols-[208px_1fr] max-md:grid-cols-1">
      <aside
        className="flex flex-col border-r border-line bg-surface max-md:hidden"
        aria-label="Main navigation"
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#171b21" />
            <path
              d="M6 20h5l3-9 4 13 3-8h5"
              fill="none"
              stroke="#7c9cff"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div>
            <div className="text-[13px] font-semibold tracking-tight">TokenFault</div>
            <div className="text-[10px] tracking-wide text-faint uppercase">Studio</div>
          </div>
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => {
            const active = route.view === item.view;
            return (
              <a
                key={item.view}
                href={`#/${item.view}`}
                aria-current={active ? 'page' : undefined}
                title={item.hint}
                className={`rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors ${active ? 'bg-surface-3 text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className="mt-auto space-y-1 border-t border-line px-4 py-3 text-[11px] text-faint">
          <div>Inspect · Replay · Break · Harden</div>
          {info && <div className="font-mono">v{info.version}</div>}
          {onSignOut && (
            <button
              type="button"
              className="text-faint underline-offset-2 hover:text-fg hover:underline"
              onClick={onSignOut}
            >
              Sign out
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
          <nav className="flex gap-1 md:hidden" aria-label="Main navigation (compact)">
            {NAV.map((item) => (
              <a
                key={item.view}
                href={`#/${item.view}`}
                className={`rounded px-2 py-1 text-[12px] ${route.view === item.view ? 'bg-surface-3' : 'text-muted'}`}
              >
                {item.label.split(' ')[0]}
              </a>
            ))}
          </nav>
          <span className="flex items-center gap-1.5 text-[12px]" role="status" aria-live="polite">
            <Dot
              tone={
                live.connection === 'open'
                  ? 'ok'
                  : live.connection === 'connecting'
                    ? 'info'
                    : 'warn'
              }
            />
            {live.connection === 'open'
              ? 'Live'
              : live.connection === 'connecting'
                ? 'Connecting'
                : 'Reconnecting'}
          </span>
          {info && (
            <span className="truncate text-[12px] text-muted">
              target <span className="font-mono text-fg">{info.target}</span>
            </span>
          )}
          {activeFaults && (
            <a
              href="#/faults"
              className="rounded border border-warn/40 bg-warn/10 px-1.5 py-px text-[11px] text-warn"
            >
              faults active:{' '}
              {activeFaults.scenarioId ?? activeFaults.faults.map((f) => f.type).join(', ')}
            </a>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              disabled={probing}
              onClick={() => void probe()}
              data-testid="send-test-request"
            >
              {probing ? 'Sending…' : 'Send test request'}
            </button>
          </div>
        </header>

        <main className="scroll-thin min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3 empty:hidden">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
          </div>
          {route.view === 'overview' && (
            <Overview
              live={live}
              info={info}
              activeFaults={activeFaults}
              onProbe={probe}
              probing={probing}
              navigate={navigate}
            />
          )}
          {route.view === 'inspector' && (
            <Inspector
              live={live}
              selectedId={route.id}
              navigate={navigate}
              onProbe={probe}
              probing={probing}
            />
          )}
          {route.view === 'faults' && (
            <FaultLab activeFaults={activeFaults} onProbe={probe} probing={probing} />
          )}
          {route.view === 'replay' && <ReplayView live={live} navigate={navigate} />}
        </main>
      </div>
    </div>
  );
}

type AuthState = 'checking' | 'signed-out' | 'open' | 'signed-in' | 'unreachable';

/** Auth gate: the workspace (and its live feed) mounts only once the control API is accessible. */
export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  const check = useCallback(() => {
    api
      .authStatus()
      .then((s) => setAuth(!s.required ? 'open' : s.authenticated ? 'signed-in' : 'signed-out'))
      .catch(() => setAuth('unreachable'));
  }, []);

  useEffect(() => {
    check();
    const onUnauthorized = (): void => setAuth('signed-out');
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [check]);

  if (auth === 'checking') return null;
  if (auth === 'unreachable') {
    return (
      <main className="flex h-full items-center justify-center p-6">
        <div className="panel max-w-md space-y-3 p-6 text-[12px]">
          <ErrorBanner error="Cannot reach the TokenFault server. Is `tokenfault proxy` still running?" />
          <button type="button" className="btn" onClick={check}>
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (auth === 'signed-out') return <SignIn onSignedIn={check} />;
  return (
    <Workspace
      onSignOut={
        auth === 'signed-in'
          ? () => {
              void api.logout().finally(() => setAuth('signed-out'));
            }
          : null
      }
    />
  );
}
