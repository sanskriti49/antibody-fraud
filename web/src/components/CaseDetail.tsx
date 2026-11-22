import { useEffect, useMemo, useState } from 'react';
import { api, type CaseContext, type CaseRecord, type Overview, type Pattern, type Trace } from '../api';
import { agentLabels, amount, dateTime, kindLabels, rule, shortId, time } from '../format';
import { useAsync } from '../hooks';
import { ActionBadge, Card, Empty, RuleChip } from './ui';

const feedbackErrors: Record<string, string> = {
  case_outside_supported_pattern: 'This session has too little evidence to teach a pattern (at least two steps with rule evidence are needed).',
  correction_not_supported_by_evidence: 'The correction must name a rule the attack had and this session lacked.',
  feedback_conflict: 'This case already has a different analyst decision.',
  decided_case_required: 'The case is still being investigated.',
  confirmed_pack_unconfigured: 'Learning is not configured on the server.',
};

export function CaseDetail({ id, overview, onOpen, onOpenPattern, onOpenPlaybook }: {
  id: string; overview: Overview | null;
  onOpen: (id: string) => void; onOpenPattern: (id: string) => void; onOpenPlaybook: (id: string) => void;
}) {
  const record = useAsync(() => api.case(id), [id]);
  const context = useAsync(() => api.context(id), [id]);
  const patterns = useAsync(() => api.patterns(), [id]);
  const publishing = context.data?.publications.some((item) => !['published', 'failed'].includes(item.state));
  useEffect(() => {
    if (!publishing) return;
    const timer = setInterval(() => { void context.reload(); void patterns.reload(); }, 2000);
    return () => clearInterval(timer);
  }, [publishing, context, patterns]);

  if (record.error) return <Empty>Could not load case: {record.error}</Empty>;
  if (!record.data) return <Empty>Loading case…</Empty>;
  const row = record.data;
  const trace = row.trace;
  const current = context.data?.session.find((item) => item.id === id);
  return (
    <div>
      <Header row={row} amountMinor={current?.amountMinor ?? null} accountId={current?.accountId} occurredAt={current?.occurredAt} />
      <ScoreMeter trace={trace} />
      <div className="rationale">{trace.rationale}</div>
      <div className="grid-2">
        <Evidence trace={trace} />
        <Session context={context.data} currentId={id} onOpen={onOpen} />
      </div>
      <Memory trace={trace} patterns={patterns.data?.items ?? []} onOpen={onOpen} onOpenPattern={onOpenPattern} />
      <Agents trace={trace} />
      <Graph trace={trace} />
      <Playbooks trace={trace} onOpenPlaybook={onOpenPlaybook} />
      <Analyst
        row={row} context={context.data} overview={overview} patterns={patterns.data?.items ?? []}
        onChanged={() => { void context.reload(); void patterns.reload(); }}
      />
    </div>
  );
}

function Header({ row, amountMinor, accountId, occurredAt }: { row: CaseRecord; amountMinor: number | null; accountId?: string; occurredAt?: string }) {
  const trace = row.trace;
  return (
    <div className="detail-head">
      <div>
        <h1>{kindLabels[trace.eventKind]}{amountMinor !== null ? ' · ' + amount(amountMinor) : ''}</h1>
        <div className="facts">
          <span>Account <strong className="mono">{shortId(accountId, 14)}</strong></span>
          {trace.sessionId && <span>Session <strong className="mono">{shortId(trace.sessionId, 14)}</strong></span>}
          {occurredAt && <span>Event time <strong>{dateTime(occurredAt)}</strong></span>}
          <span>Case <strong className="mono">{row.id.slice(0, 8)}</strong></span>
          <span>{trace.modelCalls} model calls · {Math.round(trace.durationMs)} ms</span>
        </div>
      </div>
      <div className="actions">
        <span className="chip">{trace.risk.memoryBlock ? 'Fast path · verified memory' : pathLabel(trace.path)}</span>
        <ActionBadge action={row.action} large />
      </div>
    </div>
  );
}

function pathLabel(path: string) {
  return ({ fast: 'Fast path · rules', rules_review: 'Rules review', agent_review: 'Agent review', fallback: 'Fallback · rules', pending: 'Investigating' } as Record<string, string>)[path] ?? path;
}

function ScoreMeter({ trace }: { trace: Trace }) {
  const { score, thresholds } = trace.risk;
  const color = trace.risk.memoryBlock ? 'var(--memory)' : score >= thresholds.block ? 'var(--block)' : score >= thresholds.challenge ? 'var(--step)' : 'var(--allow)';
  return (
    <div className="meter" aria-label={'Risk score ' + score + ' of 100'}>
      <div className="facts" style={{ marginBottom: 6 }}><span>Risk score <strong>{score}</strong> / 100</span>
        {trace.risk.memoryBlock && <span className="badge memory">Blocked by verified memory</span>}
        {trace.risk.hardBlock && <span className="badge BLOCK">Hard-block predicate met</span>}</div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: Math.min(100, score) + '%', background: color }} />
        <div className="meter-mark" style={{ left: thresholds.challenge + '%' }} />
        <div className="meter-mark" style={{ left: thresholds.block + '%' }} />
      </div>
      <div className="meter-labels">
        <span style={{ left: thresholds.challenge + '%' }}>step-up {thresholds.challenge}</span>
        <span style={{ left: thresholds.block + '%' }}>block {thresholds.block}</span>
      </div>
    </div>
  );
}

function Evidence({ trace }: { trace: Trace }) {
  const items = trace.risk.evidence;
  return (
    <Card title="Why this decision" aside={<span className="note">{items.length} signals</span>}>
      {items.length ? (
        <table className="evidence"><tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td><RuleChip id={item.id} /><div className="note" style={{ marginTop: 4 }}>{item.detail}</div></td>
              <td className="points">+{item.points}</td>
              <td className="source"><span className={'badge ' + (item.provenance === 'verified_memory' ? 'memory' : 'neutral')}>
                {item.provenance === 'verified_memory' ? 'memory' : 'rules'}</span></td>
            </tr>
          ))}
        </tbody></table>
      ) : <p className="note">No risk signals fired. The deterministic policy allowed the event without any model call.</p>}
    </Card>
  );
}

function Session({ context, currentId, onOpen }: { context: CaseContext | null; currentId: string; onOpen: (id: string) => void }) {
  return (
    <Card title="Session timeline" aside={<span className="note">same account and session, ±30 min</span>}>
      {!context ? <p className="note">Loading…</p> : (
        <ul className="timeline">
          {context.session.map((step) => (
            <li key={step.id} className={step.id === currentId ? 'current' : ''}>
              <span className="t">{time(step.occurredAt)}</span>
              <span className="node" />
              <div>
                <button className="link" onClick={() => onOpen(step.id)}>{kindLabels[step.kind]}{step.amountMinor !== null ? ' · ' + amount(step.amountMinor) : ''}</button>
                <div className="rules">{step.rules.map((id) => <RuleChip key={id} id={id} />)}</div>
              </div>
              <ActionBadge action={step.action} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Memory({ trace, patterns, onOpen, onOpenPattern }: {
  trace: Trace; patterns: Pattern[]; onOpen: (id: string) => void; onOpenPattern: (id: string) => void;
}) {
  const policy = trace.memoryPolicy;
  const match = policy?.match ?? null;
  const pattern = match ? patterns.find((item) => item.id === match.publicationId) : undefined;
  const signals = trace.provisionalSignals ?? [];
  const rejected = trace.rejectedMemories ?? [];
  if (!policy && !trace.reuse && !signals.length && !rejected.length) return null;
  return (
    <Card tone="memory" title="Collective memory" aside={policy && <span className="badge memory">policy: {policy.mode}</span>}>
      {match ? (
        <>
          <p style={{ marginTop: 0 }}>
            This session repeats <strong>{match.matchedSteps} of {match.totalSteps}</strong> ordered steps of an attack an analyst confirmed on another
            account ({match.points} rule points across the repeated steps). {policy?.mode === 'enforce'
              ? (policy.applied ? 'The verified-pattern policy changed this action.' : 'The ordinary policy already reached the same action.')
              : 'Shadow mode: the policy would have returned ' + (policy?.wouldAction ?? '—') + ' but kept the ordinary action.'}
          </p>
          {pattern?.steps && <Steps steps={pattern.steps} matched={match.matchedSteps} />}
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => onOpenPattern(match.publicationId)}>Open pattern v{match.version}</button>
            <button className="btn" onClick={() => onOpen(match.originCase)}>Open origin case</button>
            <span className="note mono">Meko memory {shortId(match.memoryId, 8)}</span>
          </div>
        </>
      ) : policy ? (
        <p className="note" style={{ marginTop: 0 }}>{policy.error ? 'Memory registry unavailable. Ordinary rules applied.' :
          'Checked ' + (policy.candidates ?? 0) + ' active patterns from other accounts. None repeated in this session' +
          (policy.conditionsUnmet ? ' (' + policy.conditionsUnmet + ' skipped because analyst conditions were absent)' : '') + '.'}</p>
      ) : null}
      {trace.reuse && <p className="note">The {agentLabels[trace.reuse.retrievingAgent]} agent reused verified fingerprint v{trace.reuse.version} from
        the {agentLabels[trace.reuse.originAgent]} agent and skipped a repeat review.</p>}
      {signals.length > 0 && <p className="note">{signals.length} earlier provisional observation(s) from {[...new Set(signals.map((item) => agentLabels[item.originAgent]))].join(', ')} were
        passed to {agentLabels[signals[0]!.receivingAgent]} as context only.</p>}
      {rejected.length > 0 && <p className="note">Rejected memories: {rejected.map((item) => item.reason.replaceAll('_', ' ')).join(', ')}.</p>}
    </Card>
  );
}

export function Steps({ steps, matched = 0 }: { steps: { kind: keyof typeof kindLabels; rules: string[] }[]; matched?: number }) {
  return (
    <div className="steps">
      {steps.map((step, index) => (
        <div key={index} style={{ display: 'contents' }}>
          {index > 0 && <span className="arrow" aria-hidden>→</span>}
          <div className={'step' + (index < matched ? ' matched' : '')}>
            <div className="step-kind"><span>{index + 1}. {kindLabels[step.kind]}</span>{index < matched && <span className="badge memory">matched</span>}</div>
            <div className="rules">{step.rules.map((id) => <RuleChip key={id} id={id} />)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Agents({ trace }: { trace: Trace }) {
  const team = trace.team ?? (trace.agent ? [trace.agent] : []);
  const tokens = team.flatMap((agent) => agent.attempts).reduce((sum, call) =>
    sum + (call.usage?.inputTokens ?? 0) + (call.usage?.outputTokens ?? 0), 0);
  return (
    <Card title="Agents" aside={<span className="note">{team.length ? trace.modelCalls + ' calls · ' + tokens + ' tokens' : 'no model calls'}</span>}>
      {!team.length ? <p className="note" style={{ margin: 0 }}>
        {trace.path === 'fast' || trace.path === 'rules_review' ? 'Decided by the deterministic policy. No agent was needed.' : 'No agent produced a usable assessment. The deterministic policy applied.'}
      </p> : (
        <div className="agents">
          {team.map((agent) => (
            <div className="agent" key={agent.agentId}>
              <div className="agent-head">
                <strong>{agentLabels[agent.agentId] ?? agent.agentId}</strong>
                <span className="actions">
                  <span className="note">{agent.provider} · {agent.attempts.length} call{agent.attempts.length === 1 ? '' : 's'}</span>
                  {agent.result ? <ActionBadge action={agent.result.recommendedAction} /> : <span className="badge neutral">no valid answer</span>}
                </span>
              </div>
              {agent.result && <p>{agent.result.rationale}</p>}
              {agent.result?.evidenceIds.length ? <div className="rules" style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {agent.result.evidenceIds.map((item) => <RuleChip key={item} id={item} />)}</div> : null}
            </div>
          ))}
          {trace.synthesis && <p className="note" style={{ margin: 0 }}>Advisory only: agents never set the action.
            {trace.synthesis.conflictingRecommendations ? ' Specialists disagreed.' : ''}
            {trace.synthesis.missingCorroboration.length ? ' Missing: ' + trace.synthesis.missingCorroboration.map((item) => agentLabels[item] ?? item).join(', ') + '.' : ''}</p>}
        </div>
      )}
    </Card>
  );
}

function Graph({ trace }: { trace: Trace }) {
  const paths = trace.graph?.paths ?? [];
  if (!paths.length) return null;
  return (
    <Card title="Relationships" aside={<span className="note">{paths.length} bounded paths, last 24 h</span>}>
      {paths.slice(0, 8).map((path) => (
        <div className="path" key={path.pathId}>
          {path.accounts.map((account, index) => (
            <span key={account + index} style={{ display: 'contents' }}>
              {index > 0 && <span className="via">— {path.links[index - 1]?.via.type} {shortId(path.links[index - 1]?.via.id, 8)} —</span>}
              <span className="node-pill account">{shortId(account, 10)}</span>
            </span>
          ))}
          {path.recentAuthenticationRiskEvents > 0 && <span className="badge STEP_UP_VERIFICATION">{path.recentAuthenticationRiskEvents} recent auth risk</span>}
          {path.priorConfirmedCase && <span className="badge BLOCK">linked to confirmed fraud</span>}
        </div>
      ))}
    </Card>
  );
}

function Playbooks({ trace, onOpenPlaybook }: { trace: Trace; onOpenPlaybook: (id: string) => void }) {
  const items = trace.playbooks ?? [];
  const passages = trace.knowledge?.status === 'ok' ? trace.knowledge.passages ?? [] : [];
  if (!items.length && !trace.knowledge) return null;
  return (
    <Card title="Playbooks" aside={<span className="note">approved guidance · never changes the action</span>}>
      {items.map((item) => <PlaybookChecklist key={item.id} item={item} onOpen={() => onOpenPlaybook(item.id)} />)}
      {trace.knowledge && (
        <div style={{ marginTop: 12 }}>
          <div className="note">Meko knowledge base · {trace.knowledge.status === 'ok'
            ? passages.length + ' verified passage(s), ' + (trace.knowledge.unverified ?? 0) + ' unverified'
            : 'unavailable (' + trace.knowledge.error + ')'} · {Math.round(trace.knowledge.durationMs)} ms</div>
          {passages.map((passage, index) => (
            <blockquote key={index} className="rationale" style={{ marginTop: 8 }}>
              <strong>{passage.section}</strong> <span className="note">· {passage.playbookId} v{passage.version}</span>
              <div className="note">{passage.excerpt}</div>
            </blockquote>
          ))}
        </div>
      )}
    </Card>
  );
}

function PlaybookChecklist({ item, onOpen }: { item: NonNullable<Trace['playbooks']>[number]; onOpen: () => void }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="agent-head">
        <button className="btn" style={{ border: 0, padding: 0, background: 'none', fontWeight: 600 }} onClick={onOpen}>{item.title}</button>
        <span className="actions"><span className="note">matched {item.matchedTrigger.map(rule).join(' + ')}</span>
          <span className={'badge ' + (item.knowledgeBase === 'completed' ? 'memory' : 'neutral')}>{item.knowledgeBase === 'completed' ? 'in Meko' : 'local'}</span></span>
      </div>
      <ul className="checklist">
        {item.checklist.map((text, index) => (
          <li key={index}><label>
            <input type="checkbox" checked={done.has(index)} onChange={() => setDone((previous) => {
              const next = new Set(previous);
              if (next.has(index)) next.delete(index); else next.add(index);
              return next;
            })} />
            <span>{text}</span>
          </label></li>
        ))}
      </ul>
    </div>
  );
}

function Analyst({ row, context, overview, patterns, onChanged }: {
  row: CaseRecord; context: CaseContext | null; overview: Overview | null; patterns: Pattern[]; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = row.trace.memoryPolicy?.match ?? null;
  const reuse = row.trace.reuse ?? null;
  const target = match?.publicationId ?? reuse?.publicationId ?? null;
  const pattern = patterns.find((item) => item.id === target);
  const present = new Set(row.trace.memoryPolicy?.sessionRules ?? row.trace.risk.evidence.map((item) => item.id));
  const options = useMemo(() => (pattern?.evidence ?? []).filter((id) => !present.has(id) && !pattern?.conditions.includes(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pattern, row.id]);
  const [require, setRequire] = useState('');
  useEffect(() => setRequire(options[0] ?? ''), [options]);
  const enabled = overview?.config.feedbackEnabled ?? false;
  const reviewed = Boolean(context?.feedback);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : 'request_failed';
      setError(feedbackErrors[code] ?? code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Analyst review" aside={reviewed && <span className="badge neutral">reviewed</span>}>
      {!enabled && <p className="note" style={{ marginTop: 0 }}>Learning is off on this server (no memory store configured), so feedback is read-only.</p>}
      {context?.feedback ? (
        <p style={{ marginTop: 0 }}>{context.feedback.request.verdict === 'fraud_confirmed' ? 'Confirmed as fraud' : 'Corrected as legitimate'} on {dateTime(context.feedback.createdAt)}.
          {context.feedback.publicationId && !context.publications.some((item) => item.id === context.feedback?.publicationId) && ' It corroborated an existing identical pattern.'}</p>
      ) : (
        <div className="actions">
          <button className="btn primary" disabled={!enabled || busy || !row.action} onClick={() => run(() => api.confirm(row.id))}>Confirm fraud</button>
          {target && (
            <>
              <span className="note">or correct pattern{pattern ? ' v' + pattern.version : ''}: require</span>
              <select value={require} onChange={(event) => setRequire(event.target.value)} disabled={!options.length}>
                {options.length ? options.map((id) => <option key={id} value={id}>{rule(id)}</option>) : <option>no distinguishing rule</option>}
              </select>
              <button className="btn" disabled={!enabled || busy || !require} onClick={() => run(() => api.correct(row.id, target, require))}>Mark legitimate</button>
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {context && context.publications.length > 0 && (
        <dl className="kv" style={{ marginTop: 12 }}>
          {context.publications.map((item) => (
            <div key={item.id} style={{ display: 'contents' }}>
              <dt>{item.pack === 'confirmed' ? 'Pattern v' + (item.version ?? '?') : 'Risk observation'}</dt>
              <dd><span className={'badge ' + (item.state === 'published' ? 'memory' : item.state === 'failed' ? 'BLOCK' : 'neutral')}>{item.state}</span>
                {item.state === 'published' ? ' read back from the memory store' : item.state === 'failed' ? ' ' + (item.lastError ?? '') : ' · attempt ' + item.attempts}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
