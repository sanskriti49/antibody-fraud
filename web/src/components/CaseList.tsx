import type { CaseSummary } from '../api';
import { amount, kindLabels, shortId, time } from '../format';
import { ActionBadge, Empty } from './ui';

export function CaseRow({ row, selected, fresh, onSelect }: { row: CaseSummary; selected: boolean; fresh?: boolean; onSelect: (id: string) => void }) {
  return (
    <button className={'row' + (selected ? ' selected' : '') + (fresh ? ' fresh' : '')} onClick={() => onSelect(row.id)}>
      <div className="row-title">
        <span>{kindLabels[row.kind]}</span>
        {row.amountMinor !== null && <span className="subtle">{amount(row.amountMinor)}</span>}
        {row.memoryMatch && <span className="badge memory" title="Matched an analyst-confirmed pattern">Memory</span>}
      </div>
      <div className="row-side">
        <ActionBadge action={row.action} />
        <span className="score">score {Number(row.score)}</span>
      </div>
      <div className="row-meta">
        <span>{time(row.occurredAt)}</span>
        <span className="mono">{shortId(row.accountId, 10)}</span>
        {row.modelCalls > 0 && <span>{row.modelCalls} model calls</span>}
        {row.reviewed && <span>reviewed</span>}
      </div>
    </button>
  );
}

export function CaseList({ rows, selected, freshIds, onSelect, empty }: {
  rows: CaseSummary[]; selected: string | null; freshIds?: Set<string>; onSelect: (id: string) => void; empty: string;
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return <div>{rows.map((row) => <CaseRow key={row.id} row={row} selected={row.id === selected} fresh={freshIds?.has(row.id)} onSelect={onSelect} />)}</div>;
}
