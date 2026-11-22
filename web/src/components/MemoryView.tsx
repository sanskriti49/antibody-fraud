import { useState } from 'react';
import { api, type Pattern } from '../api';
import { dateTime, kindLabels, rule, shortId } from '../format';
import { useAsync } from '../hooks';
import { Steps } from './CaseDetail';
import { Card, Empty, RuleChip } from './ui';

function status(pattern: Pattern) {
  if (pattern.revokedAt) return { label: 'Revoked', tone: 'BLOCK' };
  if (pattern.supersededAt) return { label: 'Superseded', tone: 'neutral' };
  if (pattern.state !== 'published') return { label: 'Publishing · ' + pattern.state, tone: 'STEP_UP_VERIFICATION' };
  return { label: 'Active', tone: 'memory' };
}

export function PatternList({ items, selected, onSelect }: { items: Pattern[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!items.length) return <Empty>No confirmed patterns yet. Confirm a fraud case to teach the first one.</Empty>;
  return (
    <div>
      {items.map((pattern) => {
        const state = status(pattern);
        return (
          <button key={pattern.id} className={'row' + (pattern.id === selected ? ' selected' : '')} onClick={() => onSelect(pattern.id)}>
            <div className="row-title">
              <span>{pattern.steps ? pattern.steps.map((step) => kindLabels[step.kind]).join(' → ') : 'Transfer signature'}</span>
            </div>
            <div className="row-side"><span className={'badge ' + state.tone}>{state.label}</span><span className="score">v{pattern.version}</span></div>
            <div className="row-meta">
              <span>{pattern.confirmations} confirmations</span>
              <span>{pattern.actionsChanged} actions changed</span>
              {pattern.conditions.length > 0 && <span>requires {pattern.conditions.map(rule).join(', ')}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function PatternDetail({ pattern, onChanged, onOpenCase }: { pattern: Pattern; onChanged: () => void; onOpenCase: (id: string) => void }) {
  const [reason, setReason] = useState<'incorrect_generalization' | 'invalid_confirmation'>('incorrect_generalization');
  const [error, setError] = useState<string | null>(null);
  const state = status(pattern);
  const active = state.label === 'Active';
  const matches = useAsync(() => api.cases('memory'), [pattern.id]);
  const related = (matches.data?.items ?? []).filter((item) => item.memoryMatch?.publicationId === pattern.id).slice(0, 12);
  return (
    <div>
      <div className="detail-head">
        <div>
          <h1>Confirmed attack pattern v{pattern.version}</h1>
          <div className="facts">
            <span>{pattern.pattern === 'session_sequence' ? 'Session sequence' : 'Transfer signature'}</span>
            <span>Origin account <strong className="mono">{shortId(pattern.originAccount, 12)}</strong></span>
            {pattern.verifiedAt && <span>Read back {dateTime(pattern.verifiedAt)}</span>}
            {pattern.remoteId && <span>Memory <strong className="mono">{shortId(pattern.remoteId, 8)}</strong></span>}
          </div>
        </div>
        <span className={'badge large ' + state.tone}>{state.label}</span>
      </div>
      <Card title="Steps an attacker repeated" aside={<span className="note">a later session must repeat ≥ 2 opening steps in order</span>}>
        {pattern.steps ? <Steps steps={pattern.steps} /> : <div className="rules">{pattern.required.map((id) => <RuleChip key={id} id={id} />)}</div>}
        {pattern.conditions.length > 0 && <p className="note">Analyst correction: applies only when the session also shows {pattern.conditions.map(rule).join(', ')}.</p>}
      </Card>
      <div className="grid-2">
        <Card title="Use">
          <dl className="kv">
            <dt>Confirmations</dt><dd>{pattern.confirmations}</dd>
            <dt>Sessions matched</dt><dd>{pattern.matches}</dd>
            <dt>Actions changed</dt><dd>{pattern.actionsChanged}</dd>
            <dt>Origin case</dt><dd><a href="#" onClick={(event) => { event.preventDefault(); onOpenCase(pattern.originCase); }}>{pattern.originCase.slice(0, 8)}</a></dd>
            {pattern.feedbackCase && pattern.feedbackCase !== pattern.originCase && <>
              <dt>Corrected from</dt><dd><a href="#" onClick={(event) => { event.preventDefault(); onOpenCase(pattern.feedbackCase!); }}>{pattern.feedbackCase.slice(0, 8)}</a></dd></>}
            {pattern.supersedes && <><dt>Supersedes</dt><dd className="mono">{pattern.supersedes.slice(0, 8)}</dd></>}
          </dl>
        </Card>
        <Card title="Revoke">
          {pattern.revokedAt ? <p className="note" style={{ margin: 0 }}>Revoked on {dateTime(pattern.revokedAt)} ({pattern.revocationReason?.replaceAll('_', ' ')}).</p> :
            !active ? <p className="note" style={{ margin: 0 }}>Only an active pattern can be revoked.</p> : (
            <div className="actions">
              <select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
                <option value="incorrect_generalization">Incorrect generalization</option>
                <option value="invalid_confirmation">Invalid confirmation</option>
              </select>
              <button className="btn danger" onClick={async () => {
                try { await api.revoke(pattern.id, reason); onChanged(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'failed'); }
              }}>Revoke pattern</button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <p className="note">Revocation stops all future matches. Past decisions keep their original traces.</p>
        </Card>
      </div>
      <Card title="Recent sessions it matched">
        {related.length ? related.map((item) => (
          <div className="path" key={item.id}>
            <a href="#" onClick={(event) => { event.preventDefault(); onOpenCase(item.id); }}>{kindLabels[item.kind]}</a>
            <span className="mono note">{shortId(item.accountId, 10)}</span>
            <span className={'badge ' + (item.action ?? 'pending')}>{item.action === 'BLOCK' ? 'Blocked' : item.action ?? 'Pending'}</span>
            <span className="note">{item.memoryMatch?.matchedSteps} of {item.memoryMatch?.totalSteps} steps</span>
          </div>
        )) : <p className="note" style={{ margin: 0 }}>No matches in the most recent memory cases.</p>}
      </Card>
    </div>
  );
}
