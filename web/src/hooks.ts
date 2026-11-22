import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaseSummary } from './api';

/** Hash routes: #/live, #/queue, #/memory, #/playbooks, optionally followed by /<id>. */
export function useRoute() {
  const read = () => {
    const [, tab = 'live', id] = window.location.hash.split('/');
    return { tab, id: id || null };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const go = useCallback((tab: string, id?: string | null) => { window.location.hash = '/' + tab + (id ? '/' + id : ''); }, []);
  return { ...route, go };
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    try {
      const data = await loader.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : 'Request failed', loading: false }));
    }
  }, []);
  useEffect(() => {
    setState((previous) => ({ ...previous, loading: true }));
    void reload();
    if (!refreshMs) return;
    const timer = setInterval(reload, refreshMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...state, reload };
}

export type Connection = 'connecting' | 'live' | 'reconnecting';

/** Server-sent decisions. Keeps the newest 300 and reports connection state. */
export function useLiveStream(onCases?: (rows: CaseSummary[]) => void) {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const callback = useRef(onCases);
  callback.current = onCases;
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.addEventListener('hello', () => setConnection('live'));
    source.addEventListener('cases', (event) => {
      const rows = JSON.parse((event as MessageEvent).data) as CaseSummary[];
      setCases((previous) => [...rows.reverse(), ...previous].slice(0, 300));
      callback.current?.(rows);
    });
    source.onerror = () => setConnection('reconnecting');
    source.onopen = () => setConnection('live');
    return () => source.close();
  }, []);
  return { connection, cases };
}
