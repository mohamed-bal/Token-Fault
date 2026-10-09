/**
 * Typed client for the TokenFault control API (`/__tokenfault/api`).
 */
import { API_PREFIX } from '@tokenfault/shared';
import type {
  ActiveFaults,
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

export class ControlApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

export class ControlClient {
  /**
   * @param baseUrl Proxy base URL.
   * @param token Control token (`server.controlToken`). Omit or pass `null` when the server
   *   runs with control-plane authentication disabled.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: this.headers() };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = this.headers({ 'content-type': 'application/json' });
    }
    const res = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // Non-JSON error body: use as-is.
      }
      throw new ControlApiError(res.status, message);
    }
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  info(): Promise<ServerInfo> {
    return this.call('GET', '/info');
  }

  async scenarios(): Promise<{
    scenarios: ScenarioDescriptor[];
    faultTypes: FaultTypeDescriptor[];
  }> {
    return this.call('GET', '/scenarios');
  }

  async sessions(): Promise<SessionSummary[]> {
    return (await this.call<{ sessions: SessionSummary[] }>('GET', '/sessions')).sessions;
  }

  session(id: string): Promise<SessionDetail> {
    return this.call('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  async recording(id: string, includePayloads = false): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}${API_PREFIX}/sessions/${encodeURIComponent(id)}/recording?payloads=${String(includePayloads)}`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new ControlApiError(res.status, await res.text());
    return res.text();
  }

  clearSessions(): Promise<void> {
    return this.call('DELETE', '/sessions');
  }

  async setScenario(scenarioId: string): Promise<ActiveFaults | null> {
    return (
      await this.call<{ activeFaults: ActiveFaults | null }>('PUT', '/faults', { scenarioId })
    ).activeFaults;
  }

  async setFaultProfile(profile: unknown): Promise<ActiveFaults | null> {
    return (await this.call<{ activeFaults: ActiveFaults | null }>('PUT', '/faults', { profile }))
      .activeFaults;
  }

  clearFaults(): Promise<void> {
    return this.call('DELETE', '/faults');
  }

  replay(input: {
    sessionId?: string;
    recording?: unknown;
    timing?: ReplayTiming;
  }): Promise<ReplayResponse> {
    return this.call('POST', '/replays', input);
  }

  probe(input: ProbeRequest = {}): Promise<ProbeResponse> {
    return this.call('POST', '/probe', input);
  }
}
