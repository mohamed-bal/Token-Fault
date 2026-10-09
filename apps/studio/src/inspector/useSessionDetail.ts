import { useEffect, useState } from 'react';
import type { SessionDetail } from '@tokenfault/shared';
import { api } from '../api';
import { onProgress } from '../live';

export type DetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly detail: SessionDetail };

/**
 * Loads a session and keeps it live: progress messages append new events and
 * annotations. When the session ends, the full detail (final diagnostics,
 * assembled response, chunks) is fetched once more.
 */
export function useSessionDetail(id: string | null): DetailState {
  // State is keyed by session id, so switching sessions never shows stale data
  // and no state has to be reset synchronously inside the effect.
  const [entry, setEntry] = useState<{ id: string | null; value: DetailState }>({
    id: null,
    value: { status: 'idle' },
  });

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = (): void => {
      api
        .session(id)
        .then((detail) => {
          if (!cancelled) setEntry({ id, value: { status: 'ready', detail } });
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setEntry({
              id,
              value: { status: 'error', message: e instanceof Error ? e.message : String(e) },
            });
        });
    };
    load();
    const unsubscribe = onProgress((sessionId, events, annotations, summary) => {
      if (sessionId !== id || cancelled) return;
      setEntry((prev) => {
        if (prev.id !== id || prev.value.status !== 'ready') return prev;
        const current = prev.value.detail;
        const lastSeq = current.events.at(-1)?.seq ?? -1;
        const fresh = events.filter((e) => e.seq > lastSeq);
        return {
          id,
          value: {
            status: 'ready',
            detail: {
              ...current,
              ...summary,
              events: fresh.length > 0 ? [...current.events, ...fresh] : current.events,
              annotations:
                annotations.length > 0
                  ? [...current.annotations, ...annotations]
                  : current.annotations,
            },
          },
        };
      });
      if (summary.termination !== null) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id]);

  if (!id) return { status: 'idle' };
  if (entry.id !== id) return { status: 'loading' };
  return entry.value;
}
