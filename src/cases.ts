import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inTransaction } from './database.js';
import type { FraudEvent } from './events.js';
import { extractGraph, type GraphSnapshot } from './graph.js';
import { extractFeatures, type Features } from './features.js';
import { investigate, investigateCollectively, type Investigation, type InvestigationOptions } from './investigation.js';
import { scoreRisk, type Action, type RiskAssessment, type RiskPolicy } from './risk.js';
import { evaluateVerifiedPatterns, type PatternDecision } from './learning.js';
import { currentStep, loadSessionSteps, PATTERN_POINTS, sessionRules, type MemoryPolicyMode } from './memory-policy.js';
import { selectPlaybooks, type PlaybookReference } from './playbooks.js';

type Trace = {
  version: 1;
  eventId: string;
  eventKind: FraudEvent['kind'];
  sessionId?: string;
  path: 'pending' | 'fast' | 'rules_review' | Investigation['path'];
  features: Features;
  featureExtractionMs: number;
  risk: RiskAssessment;
  context: Investigation['context'];
  agent: Investigation['agent'];
  modelCalls: number;
  action: Action | null;
  rationale: string;
  policy: { version: 1; appliedAction: Action | null; agentRecommendation: Action | null; profile?: 'extended' };
  memoryWriteBack: 'not_implemented' | 'see_publications';
  team?: Investigation['team'];
  reuse?: Investigation['reuse'];
  rejectedMemories?: Investigation['rejectedMemories'];
  synthesis?: Investigation['synthesis'];
  graph?: GraphSnapshot;
  graphError?: 'graph_unavailable';
  provisionalSignals?: Investigation['provisionalSignals'];
  provisionalContextError?: Investigation['provisionalContextError'];
  specialistContexts?: Investigation['specialistContexts'];
  memoryPolicy?: MemoryPolicyTrace;
  playbooks?: PlaybookReference[];
  knowledge?: Investigation['knowledge'];
  playbookError?: 'playbooks_unavailable';
  durationMs: number;
  leaseRecoveries: number;
};
type MemoryPolicyTrace = { mode: Exclude<MemoryPolicyMode, 'off'>; durationMs: number } & (
  | (PatternDecision & { wouldAction: Action | null; applied: boolean })
  | { error: 'memory_policy_unavailable'; match: null }
);
type CaseRow = {
  id: string;
  status: 'pending' | 'decided';
  action: Action | null;
  trace: Trace;
  created_at: Date;
  decided_at: Date | null;
};

const caseFields = 'id, status, action, trace, created_at, decided_at';

export class DuplicateEventConflict extends Error {}

export class CaseService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: RiskPolicy,
    private readonly options: InvestigationOptions,
  ) {}

  async find(id: string) {
    const result = await this.pool.query<CaseRow>('SELECT ' + caseFields + ' FROM cases WHERE id = $1', [id]);
    return result.rows[0];
  }

  async ingest(event: FraudEvent) {
    const started = performance.now();
    const payload = JSON.stringify(event);
    const lease = randomUUID();
    const collective = this.options.collective;
    const stages = collective ? this.options.advanced ? 5 : 3 : 1;
    const attemptBudget = (this.options.fallbackModel ? 3 : 2) * this.options.modelTimeoutMs + 1000;
    const leaseMs = (collective ? 2 : 1) * this.options.memoryTimeoutMs + stages * attemptBudget + 15_000;

    const claim = await inTransaction(this.pool, async (db) => {
      // Serializes same-account history snapshots and stays out of provider calls.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [event.accountId]);

      const inserted = await db.query(`
        INSERT INTO events (id, occurred_at, account_id, kind, device_id, network_id, payee_id,
          amount_minor, latitude, longitude, dwell_ms, flight_ms, interaction_ms, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO NOTHING
      `, [
        event.id, event.timestamp, event.accountId, event.kind, event.deviceId, event.networkId,
        'payeeId' in event ? event.payeeId : null, 'amountMinor' in event ? event.amountMinor : null,
        event.location.latitude, event.location.longitude,
        event.behaviour?.dwellMs, event.behaviour?.flightMs, event.behaviour?.interactionMs, payload,
      ]);

      if (inserted.rowCount === 0) {
        const winner = await db.query<{ same: boolean }>('SELECT payload = $2::jsonb AS same FROM events WHERE id = $1', [event.id, payload]);
        if (!winner.rows[0]?.same) throw new DuplicateEventConflict('Event ID already has a different payload');
        const recovered = await db.query<CaseRow>(`
          UPDATE cases SET lease_token = $2, lease_until = clock_timestamp() + $3 * interval '1 ms'
          WHERE id = $1 AND status = 'pending' AND lease_until <= clock_timestamp()
          RETURNING ${caseFields}
        `, [event.id, lease, leaseMs]);
        const resumed = recovered.rows[0];
        if (resumed) {
          const updated = await db.query<CaseRow>(`
            UPDATE cases SET trace = jsonb_set(trace, '{leaseRecoveries}', to_jsonb($2::int))
            WHERE id = $1 RETURNING ${caseFields}
          `, [event.id, resumed.trace.leaseRecoveries + 1]);
          return { row: updated.rows[0]!, run: true, duplicate: true };
        }
        const existing = await db.query<CaseRow>('SELECT ' + caseFields + ' FROM cases WHERE id = $1', [event.id]);
        if (!existing.rows[0]) throw new Error('Stored event missing a case');
        return { row: existing.rows[0], run: false, duplicate: true };
      }

      const featureStarted = performance.now();
      const features = await extractFeatures(db, event);
      const featureExtractionMs = performance.now() - featureStarted;
      const earlySession = Boolean(this.options.advanced && event.sessionId);
      let risk = scoreRisk(event.kind, features, this.policy, earlySession);
      const memoryMode = this.options.memoryPolicy ?? 'off';
      let memoryPolicy: MemoryPolicyTrace | undefined;
      if (memoryMode !== 'off') {
        const memoryStarted = performance.now();
        await db.query('SAVEPOINT memory_policy');
        try {
          const decision = await evaluateVerifiedPatterns(db, event, risk.evidence);
          const match = decision.match;
          const withMemory = match ? scoreRisk(event.kind, features, this.policy, earlySession, {
            points: PATTERN_POINTS,
            detail: 'Session repeats ' + match.matchedSteps + ' of ' + match.totalSteps + ' ordered steps of analyst-confirmed pattern v' +
              match.version + ' (publication ' + match.publicationId + ', origin case ' + match.originCase + ')',
          }) : null;
          const applied = memoryMode === 'enforce' && withMemory !== null && withMemory.preliminaryAction !== risk.preliminaryAction;
          if (memoryMode === 'enforce' && withMemory) risk = withMemory;
          memoryPolicy = {
            mode: memoryMode, ...decision, wouldAction: withMemory?.preliminaryAction ?? null, applied,
            durationMs: performance.now() - memoryStarted,
          };
        } catch {
          await db.query('ROLLBACK TO SAVEPOINT memory_policy');
          // A local registry failure keeps the ordinary deterministic policy.
          memoryPolicy = { mode: memoryMode, error: 'memory_policy_unavailable', match: null, durationMs: performance.now() - memoryStarted };
        }
        await db.query('RELEASE SAVEPOINT memory_policy');
      }
      const run = risk.needsInvestigation && this.options.mode !== 'rules';
      let graph: GraphSnapshot | undefined;
      let graphError: Trace['graphError'];
      const inspectGraph = run && collective && this.options.advanced && (
        features.sharedDeviceAccounts24h > 0 || features.sharedNetworkAccounts24h > 0 || 'payeeId' in event
      );
      if (inspectGraph) {
        await db.query('SAVEPOINT graph_evidence');
        try {
          graph = await extractGraph(db, event);
        } catch {
          await db.query('ROLLBACK TO SAVEPOINT graph_evidence');
          graphError = 'graph_unavailable';
        }
        await db.query('RELEASE SAVEPOINT graph_evidence');
      }
      // Approved playbooks are read-only context for alerted or investigated events.
      let playbooks: PlaybookReference[] | undefined;
      let playbookError: Trace['playbookError'];
      if (run || risk.preliminaryAction !== 'ALLOW') {
        await db.query('SAVEPOINT playbook_context');
        try {
          const rules = memoryPolicy && 'sessionRules' in memoryPolicy ? memoryPolicy.sessionRules : sessionRules([
            ...await loadSessionSteps(db, { accountId: event.accountId, occurredAt: event.timestamp, sessionId: event.sessionId, excludeId: event.id }),
            currentStep(event.kind, risk.evidence),
          ]);
          playbooks = await selectPlaybooks(db, [...new Set([...rules, ...risk.evidence.map((item) => item.id)])]);
        } catch {
          await db.query('ROLLBACK TO SAVEPOINT playbook_context');
          playbookError = 'playbooks_unavailable';
        }
        await db.query('RELEASE SAVEPOINT playbook_context');
      }
      const action = run ? null : risk.preliminaryAction;
      const trace: Trace = {
        version: 1, eventId: event.id, eventKind: event.kind, sessionId: event.sessionId,
        path: run ? 'pending' : risk.needsInvestigation ? 'rules_review' : 'fast',
        features, featureExtractionMs, risk, graph, graphError, memoryPolicy, playbooks, playbookError,
        action, context: null, agent: null, modelCalls: 0,
        rationale: run ? 'Awaiting specialist investigation.' :
          action === 'BLOCK' && risk.memoryBlock ? 'The session repeats an analyst-confirmed attack pattern from another account. The verified-pattern policy blocks it.' :
          action === 'BLOCK' ? 'Score and hard-block predicate satisfy policy.' :
          action === 'STEP_UP_VERIFICATION' ? 'The score requires step-up verification under rules-only policy.' :
          event.kind === 'login_failed' ? 'Recorded a failed login as an observation without authorizing authentication.' :
          'Score is below the step-up threshold.',
        policy: { version: 1, appliedAction: action, agentRecommendation: null, ...(this.options.advanced ? { profile: 'extended' as const } : {}) },
        memoryWriteBack: 'not_implemented', durationMs: performance.now() - started, leaseRecoveries: 0,
      };
      const result = await db.query<CaseRow>(`
        INSERT INTO cases (id, status, action, trace, lease_token, lease_until, decided_at)
        VALUES ($1, $2, $3, $4, $5,
          CASE WHEN $5::uuid IS NOT NULL THEN clock_timestamp() + $6 * interval '1 ms' END,
          CASE WHEN $5::uuid IS NULL THEN clock_timestamp() END)
        RETURNING ${caseFields}
      `, [event.id, run ? 'pending' : 'decided', action, JSON.stringify(trace), run ? lease : null, leaseMs]);
      if (!result.rows[0]) throw new Error('Case insert returned no row');
      return { row: result.rows[0], run, duplicate: false };
    });

    if (!claim.run) return { duplicate: claim.duplicate, case: claim.row };
    const snapshot = claim.row.trace;
    const assessment = collective
      ? await investigateCollectively(event.id, event.kind, snapshot.features, snapshot.risk, this.options, snapshot.graph, snapshot.playbooks)
      : await investigate(event.id, snapshot.features, snapshot.risk, this.options);
    const learning = collective && this.options.mode === 'meko' && this.options.publishProvisional !== false ? this.options.learning : undefined;
    const observations = assessment.team?.filter((agent) => agent.result?.evidence.length) ?? [];
    // A provider score or recommendation cannot weaken or strengthen the simulated policy action.
    const action = snapshot.risk.preliminaryAction;
    const trace: Trace = {
      ...snapshot, ...assessment, action,
      modelCalls: assessment.team?.reduce((sum, agent) => sum + agent.attempts.length, 0) ?? assessment.agent?.attempts.length ?? 0,
      memoryWriteBack: learning ? 'see_publications' : 'not_implemented',
      policy: { ...snapshot.policy, appliedAction: action, agentRecommendation: assessment.agent?.result?.recommendedAction ?? null },
      durationMs: performance.now() - started,
    };
    const save = async (db: Pick<pg.PoolClient, 'query'>) => db.query<CaseRow>(`
      UPDATE cases SET action = $2, trace = $3, status = 'decided', decided_at = clock_timestamp(),
        lease_token = NULL, lease_until = NULL
      WHERE id = $1 AND status = 'pending' AND lease_token = $4 RETURNING ${caseFields}
    `, [event.id, action, JSON.stringify(trace), lease]);
    const decided = learning ? await inTransaction(this.pool, async (db) => {
      const saved = await save(db);
      if (saved.rows[0]) {
        for (const agent of observations) await learning.recordObservation(db, event.id, agent);
      }
      return saved;
    }) : await save(this.pool);
    const row = decided.rows[0] ?? await this.find(event.id);
    if (!row) throw new Error('Case missing after investigation');
    return { duplicate: claim.duplicate, case: row };
  }
}
