/** Minimal hash router: #/<view>/<id?>. Keeps deep links working behind any base path. */
import { useCallback, useEffect, useState } from 'react';

export type View = 'overview' | 'inspector' | 'faults' | 'replay';
export interface Route {
  readonly view: View;
  readonly id: string | null;
}

const VIEWS: readonly View[] = ['overview', 'inspector', 'faults', 'replay'];

function parse(hash: string): Route {
  const [view, id] = hash.replace(/^#\/?/, '').split('/');
  return {
    view: VIEWS.includes(view as View) ? (view as View) : 'overview',
    id: id ? decodeURIComponent(id) : null,
  };
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    window.location.hash = `#/${next.view}${next.id ? `/${encodeURIComponent(next.id)}` : ''}`;
  }, []);
  return [route, navigate];
}
