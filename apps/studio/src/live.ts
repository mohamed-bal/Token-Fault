/**
 * Live connection to the server's session feed (SSE). EventSource reconnects
 * automatically. Every (re)connection starts with a full snapshot, so state
 * never drifts.
 */
import { useEffect, useReducer } from 'react';
import type {
  ActiveFaults,
  CapturedEvent,
  FaultAnnotation,
  LiveMessage,
  SessionSummary,
} from '@tokenfault/shared';
import { API } from './api';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

export interface LiveState {
  readonly connection: ConnectionState;
  /** Newest first. */
  readonly sessions: readonly SessionSummary[];
  readonly activeFaults: ActiveFaults | null | undefined;
  /** Incremented on every message; lets detail views know new data arrived. */
  readonly revision: number;
}

export interface ProgressListener {
  (
    sessionId: string,
    events: readonly CapturedEvent[],
    annotations: readonly FaultAnnotation[],
    summary: SessionSummary,
  ): void;
}

type Action =
  { type: 'connection'; state: ConnectionState } | { type: 'message'; message: LiveMessage };

const MAX_SESSIONS_IN_UI = 500;

function upsert(list: readonly SessionSummary[], session: SessionSummary): SessionSummary[] {
  const index = list.findIndex((s) => s.id === session.id);
  if (index === -1) return [session, ...list].slice(0, MAX_SESSIONS_IN_UI);
  const next = [...list];
  next[index] = session;
  return next;
}

function reducer(state: LiveState, action: Action): LiveState {
  if (action.type === 'connection') return { ...state, connection: action.state };
  const m = action.message;
  const revision = state.revision + 1;
  switch (m.type) {
    case 'snapshot':
      return {
        ...state,
        sessions: m.sessions.slice(0, MAX_SESSIONS_IN_UI),
        connection: 'open',
        revision,
      };
    case 'session-started':
    case 'session-progress':
    case 'session-ended':
      return { ...state, sessions: upsert(state.sessions, m.session), revision };
    case 'sessions-cleared':
      return { ...state, sessions: [], revision };
    case 'faults-changed':
      return { ...state, activeFaults: m.activeFaults, revision };
  }
}

const listeners = new Set<ProgressListener>();

/** Subscribes to per-session progress (used by the inspector to append events live). */
export function onProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLive(): LiveState {
  const [state, dispatch] = useReducer(reducer, {
    connection: 'connecting',
    sessions: [],
    activeFaults: undefined,
    revision: 0,
  });

  useEffect(() => {
    const source = new EventSource(`${API}/live`);
    source.onopen = () => dispatch({ type: 'connection', state: 'open' });
    source.onerror = () => dispatch({ type: 'connection', state: 'reconnecting' });
    source.onmessage = (event: MessageEvent<string>) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(event.data) as LiveMessage;
      } catch {
        return; // Ignore malformed frames; the next snapshot resynchronises.
      }
      if (message.type === 'session-progress' || message.type === 'session-ended') {
        const events = message.type === 'session-progress' ? message.events : [];
        const annotations = message.type === 'session-progress' ? message.annotations : [];
        for (const l of listeners) l(message.session.id, events, annotations, message.session);
      }
      dispatch({ type: 'message', message });
    };
    return () => source.close();
  }, []);

  return state;
}
