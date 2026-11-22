import type { ReactNode } from 'react';
import type { Action } from '../api';
import { actionLabels, rule } from '../format';

export function ActionBadge({ action, large }: { action: Action | null; large?: boolean }) {
  if (!action) return <span className={'badge pending' + (large ? ' large' : '')}>Pending</span>;
  return <span className={'badge ' + action + (large ? ' large' : '')}>{actionLabels[action]}</span>;
}

export function RuleChip({ id, tone }: { id: string; tone?: 'memory' | 'matched' }) {
  const memory = id === 'verified_pattern_match';
  return <span className={'rule-chip' + (tone ? ' ' + tone : memory ? ' memory' : '')} title={id}>{rule(id)}</span>;
}

export function Card({ title, aside, tone, children }: { title: ReactNode; aside?: ReactNode; tone?: 'memory'; children: ReactNode }) {
  return (
    <section className={'card' + (tone ? ' ' + tone : '')}>
      <div className="card-head"><h3>{title}</h3>{aside}</div>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
