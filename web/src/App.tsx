import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type CaseSummary, type View } from './api';
import { CaseDetail } from './components/CaseDetail';
import { CaseList } from './components/CaseList';
import { PatternDetail, PatternList } from './components/MemoryView';
import { PlaybookDetail, PlaybookList } from './components/PlaybooksView';
import { Empty } from './components/ui';
import { useAsync, useLiveStream, useRoute } from './hooks';

const queueViews: { id: View; label: string }[] = [
  { id: 'review', label: 'Needs review' }, { id: 'blocked', label: 'Blocked' }, { id: 'memory', label: 'Memory' }, { id: 'alerts', label: 'All alerts' },
];

export function App() {
  const route = useRoute();
  const overview = useAsync(() => api.overview(), [], 10_000);
  const refresh = useRef<number | undefined>(undefined);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const live = useLiveStream((rows) => {
    window.clearTimeout(refresh.current);
    refresh.current = window.setTimeout(() => void overview.reload(), 600);
    setFresh(new Set(rows.map((row) => row.id)));
  });

  const counts = overview.data?.counts;
  const config = overview.data?.config;
  const tabs = [
    { id: 'live', label: 'Live stream' },
    { id: 'queue', label: 'Review queue', count: counts ? counts.stepUps + counts.blocks : undefined },
    { id: 'memory', label: 'Memory', count: overview.data?.memory.activePatterns },
    { id: 'playbooks', label: 'Playbooks', count: overview.data?.playbooks },
  ];
  const openCase = (id: string) => route.go(route.tab === 'live' ? 'live' : 'queue', id);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>✓</span>Fraud Intelligence</div>
        {config && (
          <div className="chips">
            <span className="chip">investigation <strong>{config.mode}</strong></span>
            <span className="chip">memory policy <strong>{config.memoryPolicy}</strong></span>
            <span className={'chip' + (config.memoryStore === 'local' ? ' warn' : '')} title={config.memoryStore === 'local' ? 'In-process stand-in, not hosted Meko' : ''}>
              store <strong>{config.memoryStore === 'meko' ? 'Meko' : config.memoryStore === 'local' ? 'local stand-in' : 'none'}</strong></span>
          </div>
        )}
        <span className="spacer" />
        <span className="connection" role="status">
          <span className={'dot ' + live.connection} />
          {live.connection === 'live' ? 'Live' : live.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
      </header>

      <section className="kpis" aria-label="Summary">
        <Kpi label="Events processed" value={counts?.events} note={counts ? counts.modelCalls + ' model calls' : undefined} />
        <Kpi label="Step-up verifications" value={counts?.stepUps} tone="step" />
        <Kpi label="Blocked" value={counts?.blocks} tone="block" />
        <Kpi label="Blocked by memory" value={counts?.memoryBlocks} tone="memory" note="repeats a confirmed attack" />
        <Kpi label="Patterns learned" value={overview.data?.memory.activePatterns} tone="memory" note={overview.data ? overview.data.memory.patternVersions + ' versions' : undefined} />
        <Kpi label="Analyst reviews" value={counts?.reviews} />
      </section>

      <nav className="tabs" aria-label="Sections">
        {tabs.map((tab) => (
          <button key={tab.id} className={'tab' + (route.tab === tab.id ? ' active' : '')} onClick={() => route.go(tab.id)}>
            {tab.label}{tab.count !== undefined && <span className="count">{tab.count}</span>}
          </button>
        ))}
      </nav>

      {route.tab === 'live' && <LiveTab stream={live.cases} fresh={fresh} selected={route.id} onSelect={(id) => route.go('live', id)}
        detail={route.id && <CaseDetail id={route.id} overview={overview.data} onOpen={openCase}
          onOpenPattern={(id) => route.go('memory', id)} onOpenPlaybook={(id) => route.go('playbooks', id)} />} />}
      {route.tab === 'queue' && <QueueTab selected={route.id} onSelect={(id) => route.go('queue', id)} stamp={overview.data?.counts.reviews}
        detail={route.id && <CaseDetail id={route.id} overview={overview.data} onOpen={openCase}
          onOpenPattern={(id) => route.go('memory', id)} onOpenPlaybook={(id) => route.go('playbooks', id)} />} />}
      {route.tab === 'memory' && <MemoryTab selected={route.id} go={route.go} stamp={overview.data?.memory.patternVersions} />}
      {route.tab === 'playbooks' && <PlaybooksTab selected={route.id} go={route.go} />}
    </div>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value?: number; note?: string; tone?: string }) {
  return (
    <div className={'kpi' + (tone ? ' ' + tone : '')}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value === undefined ? '—' : value.toLocaleString()}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

function LiveTab({ stream, fresh, selected, onSelect, detail }: {
  stream: CaseSummary[]; fresh: Set<string>; selected: string | null; onSelect: (id: string) => void; detail: React.ReactNode;
}) {
  const initial = useAsync(() => api.cases('all'), []);
  const [alertsOnly, setAlertsOnly] = useState(false);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [...stream, ...(initial.data?.items ?? [])].filter((row) => !seen.has(row.id) && seen.add(row.id))
      .filter((row) => !alertsOnly || row.action !== 'ALLOW').slice(0, 300);
  }, [stream, initial.data, alertsOnly]);
  return (
    <main className="workspace">
      <aside className="pane list-pane">
        <div className="list-head">
          <h2>Decisions as they happen</h2>
          <span className="spacer" />
          <div className="filters">
            <button className={'filter' + (!alertsOnly ? ' active' : '')} onClick={() => setAlertsOnly(false)}>All</button>
            <button className={'filter' + (alertsOnly ? ' active' : '')} onClick={() => setAlertsOnly(true)}>Alerts</button>
          </div>
        </div>
        <CaseList rows={rows} selected={selected} freshIds={fresh} onSelect={onSelect}
          empty="Waiting for events. Run npm run demo:feed to stream a synthetic tape." />
      </aside>
      <section className="pane detail-pane">{detail || <Empty>Select a decision to see its evidence, session, memory and agents.</Empty>}</section>
    </main>
  );
}

function QueueTab({ selected, onSelect, detail, stamp }: { selected: string | null; onSelect: (id: string) => void; detail: React.ReactNode; stamp?: number }) {
  const [view, setView] = useState<View>('review');
  const [extra, setExtra] = useState<CaseSummary[]>([]);
  const list = useAsync(() => api.cases(view), [view, stamp], 5000);
  useEffect(() => setExtra([]), [view]);
  const rows = [...(list.data?.items ?? []), ...extra];
  const last = rows.at(-1);
  return (
    <main className="workspace">
      <aside className="pane list-pane">
        <div className="list-head">
          <div className="filters">
            {queueViews.map((item) => <button key={item.id} className={'filter' + (view === item.id ? ' active' : '')} onClick={() => setView(item.id)}>{item.label}</button>)}
          </div>
        </div>
        <CaseList rows={rows} selected={selected} onSelect={onSelect} empty={view === 'review' ? 'Nothing waiting for review.' : 'No cases in this view yet.'} />
        {last && rows.length >= 60 && (
          <button className="btn more" onClick={async () => setExtra([...extra, ...(await api.cases(view, last)).items])}>Load older</button>
        )}
      </aside>
      <section className="pane detail-pane">{detail || <Empty>Select a case to review it.</Empty>}</section>
    </main>
  );
}

function MemoryTab({ selected, go, stamp }: { selected: string | null; go: (tab: string, id?: string | null) => void; stamp?: number }) {
  const patterns = useAsync(() => api.patterns(), [stamp], 5000);
  const items = patterns.data?.items ?? [];
  const pattern = items.find((item) => item.id === selected) ?? null;
  return (
    <main className="workspace">
      <aside className="pane list-pane">
        <div className="list-head"><h2>Confirmed patterns</h2></div>
        <PatternList items={items} selected={selected} onSelect={(id) => go('memory', id)} />
      </aside>
      <section className="pane detail-pane">
        {pattern ? <PatternDetail pattern={pattern} onChanged={() => void patterns.reload()} onOpenCase={(id) => go('queue', id)} />
          : <Empty>Patterns are learned when an analyst confirms a fraud case. Select one to see its steps, use and corrections.</Empty>}
      </section>
    </main>
  );
}

function PlaybooksTab({ selected, go }: { selected: string | null; go: (tab: string, id?: string | null) => void }) {
  const playbooks = useAsync(() => api.playbooks(), []);
  const items = playbooks.data?.items ?? [];
  const playbook = items.find((item) => item.id === selected) ?? items[0] ?? null;
  return (
    <main className="workspace">
      <aside className="pane list-pane">
        <div className="list-head"><h2>Approved playbooks</h2></div>
        <PlaybookList items={items} selected={playbook?.id ?? null} onSelect={(id) => go('playbooks', id)} />
      </aside>
      <section className="pane detail-pane">{playbook ? <PlaybookDetail playbook={playbook} /> : <Empty>No playbooks loaded.</Empty>}</section>
    </main>
  );
}
