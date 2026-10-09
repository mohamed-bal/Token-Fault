/**
 * In-memory, bounded session store with change notifications.
 *
 * - At most `maxSessions` sessions are kept; the oldest is evicted first.
 * - Each session's capture is bounded by the inspector limits.
 * - Progress notifications are batched (default every 50 ms), so a fast
 *   stream does not flood live-feed subscribers.
 */
import { StreamInspector, sessionDetail, sessionSummary } from '@tokenfault/core';
import type { InspectorLimits, SessionMeta } from '@tokenfault/core';
import type {
  ActiveFaults,
  CapturedEvent,
  Diagnostic,
  FaultAnnotation,
  HeaderInput,
  LiveMessage,
  SessionDetail,
  SessionSummary,
  Termination,
} from '@tokenfault/shared';

export class Session {
  readonly inspector: StreamInspector;
  readonly annotations: FaultAnnotation[] = [];
  ended = false;

  constructor(
    readonly meta: SessionMeta,
    readonly seed: number | null,
    capturePayloads: boolean,
    limits: InspectorLimits,
  ) {
    this.inspector = new StreamInspector({ capturePayloads, limits });
  }

  get id(): string {
    return this.meta.id;
  }

  summary(): SessionSummary {
    return sessionSummary(this.meta, this.inspector);
  }

  detail(): SessionDetail {
    return sessionDetail(this.meta, this.inspector, this.annotations);
  }
}

export type StoreListener = (message: LiveMessage) => void;
export type SessionEndListener = (session: Session) => void;

export interface SessionStoreOptions {
  readonly maxSessions: number;
  readonly capturePayloads: boolean;
  readonly limits: InspectorLimits;
  readonly flushIntervalMs?: number;
  readonly maxAnnotationsPerSession?: number;
}

interface Pending {
  events: CapturedEvent[];
  annotations: FaultAnnotation[];
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<StoreListener>();
  private readonly endListeners = new Set<SessionEndListener>();
  private readonly pending = new Map<Session, Pending>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;
  private readonly maxAnnotations: number;

  constructor(private readonly options: SessionStoreOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxAnnotations = options.maxAnnotationsPerSession ?? 1_000;
  }

  get capturePayloads(): boolean {
    return this.options.capturePayloads;
  }

  create(meta: SessionMeta, seed: number | null): Session {
    const session = new Session(meta, seed, this.options.capturePayloads, this.options.limits);
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.options.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      const evicted = this.sessions.get(oldest.value);
      this.sessions.delete(oldest.value);
      if (evicted) this.pending.delete(evicted);
    }
    this.emit({ type: 'session-started', session: session.summary() });
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].reverse().map((s) => s.summary());
  }

  get size(): number {
    return this.sessions.size;
  }

  onHeaders(session: Session, status: number, headers: HeaderInput, atMs: number): Diagnostic[] {
    const diagnostics = session.inspector.onHeaders(status, headers, atMs);
    this.queue(session, [], []);
    return diagnostics;
  }

  recordChunk(session: Session, bytes: Uint8Array, atMs: number): void {
    if (session.ended) return;
    const update = session.inspector.onChunk(bytes, atMs);
    this.queue(session, update.events, []);
  }

  annotate(session: Session, annotation: FaultAnnotation): void {
    if (session.annotations.length >= this.maxAnnotations) return;
    session.annotations.push(annotation);
    this.queue(session, [], [annotation]);
  }

  end(session: Session, termination: Termination): void {
    if (session.ended) return;
    const update = session.inspector.onEnd(termination);
    session.ended = true;
    this.queue(session, update.events, []);
    this.flushSession(session);
    // UI notifications only for retained sessions, but end listeners (the recorder) always run:
    // a session evicted or cleared while streaming must still be recorded.
    if (this.sessions.get(session.id) === session) {
      this.emit({ type: 'session-ended', session: session.summary() });
    }
    for (const listener of this.endListeners) {
      try {
        listener(session);
      } catch {
        // A failing end listener must not affect request handling or other listeners.
      }
    }
  }

  clear(): void {
    this.sessions.clear();
    this.pending.clear();
    this.emit({ type: 'sessions-cleared' });
  }

  announceFaults(active: ActiveFaults | null): void {
    this.emit({ type: 'faults-changed', activeFaults: active });
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onSessionEnd(listener: SessionEndListener): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.listeners.clear();
    this.endListeners.clear();
  }

  private queue(
    session: Session,
    events: readonly CapturedEvent[],
    annotations: readonly FaultAnnotation[],
  ): void {
    if (this.listeners.size === 0) return;
    let entry = this.pending.get(session);
    if (!entry) {
      entry = { events: [], annotations: [] };
      this.pending.set(session, entry);
    }
    entry.events.push(...events);
    entry.annotations.push(...annotations);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      for (const s of [...this.pending.keys()]) this.flushSession(s);
    }, this.flushIntervalMs);
  }

  private flushSession(session: Session): void {
    const entry = this.pending.get(session);
    if (!entry) return;
    this.pending.delete(session);
    if (this.sessions.get(session.id) !== session) return;
    this.emit({
      type: 'session-progress',
      session: session.summary(),
      events: entry.events,
      annotations: entry.annotations,
    });
  }

  private emit(message: LiveMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A failing subscriber must not break request handling; it is removed.
        this.listeners.delete(listener);
      }
    }
  }
}
