/**
 * Typed client for the TokenFault control API. Same-origin only: the Studio
 * is served by the proxy itself, so no credentials or CORS are involved.
 */
import type {
  ActiveFaults,
  AuthStatus,
  FaultTypeDescriptor,
  ProbeRequest,
  ProbeResponse,
  ReplayResponse,
  ReplayTiming,
  ScenarioDescriptor,
  ServerInfo,
  SessionDetail,
  SessionSummary,
} from '@tokenfault/shared';

export const API = '/__tokenfault/api';
export const UNAUTHORIZED_EVENT = 'tokenfault:unauthorized';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { accept: 'application/json', 'content-type': 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, init);
  } catch {
    throw new ApiError(
      0,
      'Cannot reach the TokenFault server. Is `tokenfault proxy` still running?',
    );
  }
  const text = await res.text();
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Session expired or never established: the app shell switches to the sign-in screen.
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // Body was not JSON.
    }
    throw new ApiError(res.status, message);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  authStatus: () => call<AuthStatus>('GET', '/auth/status'),
  login: (token: string) => call<{ authenticated: boolean }>('POST', '/auth/login', { token }),
  logout: () => call<void>('POST', '/auth/logout'),
  info: () => call<ServerInfo>('GET', '/info'),
  scenarios: () =>
    call<{ scenarios: ScenarioDescriptor[]; faultTypes: FaultTypeDescriptor[] }>(
      'GET',
      '/scenarios',
    ),
  session: (id: string) => call<SessionDetail>('GET', `/sessions/${encodeURIComponent(id)}`),
  clearSessions: () => call<void>('DELETE', '/sessions'),
  setScenario: (scenarioId: string) =>
    call<{ activeFaults: ActiveFaults | null }>('PUT', '/faults', { scenarioId }),
  setProfile: (profile: unknown) =>
    call<{ activeFaults: ActiveFaults | null }>('PUT', '/faults', { profile }),
  clearFaults: () => call<void>('DELETE', '/faults'),
  probe: (req: ProbeRequest) => call<ProbeResponse>('POST', '/probe', req),
  replay: (req: { sessionId?: string; recording?: unknown; timing: ReplayTiming }) =>
    call<ReplayResponse>('POST', '/replays', req),
  recordingUrl: (id: string, payloads: boolean) =>
    `${API}/sessions/${encodeURIComponent(id)}/recording?payloads=${String(payloads)}`,
};

export type { SessionSummary };
