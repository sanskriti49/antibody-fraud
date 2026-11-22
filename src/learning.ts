import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { DEVICE_AGENT } from './device-evidence.js';
import { inTransaction } from './database.js';
import type { ContextSearch } from './integrations/ports.js';
import { failureCode } from './integrations/ports.js';
import { MekoRateLimit, MekoWriteNotSent } from './integrations/meko.js';
import type { AgentTrace, Investigation } from './investigation.js';
import type { RiskAssessment } from './risk.js';
import {
  compactSteps, currentStep, loadSessionSteps, MIN_MATCHED_STEPS, MIN_MATCHED_POINTS, PATTERN_FRESHNESS_DAYS,
  matchPattern, sessionRules, stepPoints, type PatternMatch, type PatternStep,
} from './memory-policy.js';
import { bindKnowledgeHits } from './playbooks.js';

export const LOGIN_AGENT = 'contextcon-behaviour-login';
export const GRAPH_AGENT = 'contextcon-graph';
export const TRANSFER_AGENT = 'contextcon-transactions';
/** Attribution for patterns an analyst confirmed from deterministic session evidence. */
export const INVESTIGATOR_AGENT = 'contextcon-investigator';
const specialists = [LOGIN_AGENT, TRANSFER_AGENT, DEVICE_AGENT, GRAPH_AGENT] as const;
export const FINGERPRINT_QUERY = 'ContextCon suspicious transfer interaction timing shift recently registered payee unusual amount';
const signature = ['behaviour_shift', 'fresh_payee', 'amount_spike'] as const;
const ruleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const stepSchema = z.strictObject({
  kind: z.enum(['login', 'login_failed', 'password_reset', 'payee_added', 'transfer']),
  rules: z.array(ruleSchema).min(1).max(16),
});
const documentSchema = z.strictObject({
  format: z.literal('contextcon-learning-v1'),
  publicationId: z.uuid(),
  kind: z.enum(['observation', 'fingerprint']),
  originCase: z.uuid(),
  originAgent: z.enum([...specialists, INVESTIGATOR_AGENT]),
  feedbackCase: z.uuid().nullable(),
  verification: z.enum(['provisional', 'analyst_confirmed']),
  version: z.int().positive(),
  supersedes: z.uuid().nullable(),
  evidence: z.array(ruleSchema).min(1).max(16),
  required: z.array(ruleSchema).max(12),
  // Absent on documents written before session patterns existed; those are transfer signatures.
  pattern: z.enum(['transfer_signature', 'session_sequence']).optional(),
  steps: z.array(stepSchema).min(2).max(12).optional(),
  // Rules an analyst correction requires somewhere in the session before the pattern applies.
  conditions: z.array(ruleSchema).max(12).optional(),
});
export type LearningDocument = z.infer<typeof documentSchema>;
export type Pack = 'risk' | 'confirmed';
type RecordHit = { id: string | null; text: string | null };
export interface MemoryGateway {
  search(query: string, agentId: string, signal: AbortSignal): Promise<ContextSearch & { records: RecordHit[] }>;
  recent(agentId: string, signal: AbortSignal): Promise<RecordHit[]>;
  read(id: string, agentId: string, signal: AbortSignal): Promise<RecordHit | null>;
  write(text: string, agentId: string, signal: AbortSignal): Promise<string | null>;
  knowledgeSearch?(query: string, agentId: string, signal: AbortSignal, limit?: number): Promise<{ hits: KnowledgeHit[] }>;
}
export type KnowledgeHit = { documentId: string | null; text: string | null; score: number | null; rank?: number | null };

export const feedbackSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ verdict: z.literal('fraud_confirmed') }),
  z.strictObject({ verdict: z.literal('legitimate_correction'), publicationId: z.uuid(), require: ruleSchema }),
]);
export type Feedback = z.infer<typeof feedbackSchema>;
export const fingerprintRevocationSchema = z.strictObject({
  reason: z.enum(['invalid_confirmation', 'incorrect_generalization']),
});
type FingerprintRevocation = z.infer<typeof fingerprintRevocationSchema>;
type Publication = {
  id: string; pack: Pack; document: LearningDocument;
  state: 'pending' | 'sending' | 'indexing' | 'uncertain' | 'published' | 'failed';
  remote_id: string | null; attempts: number; superseded_at: Date | null;
  next_check_at: Date; last_error: string | null; last_operation: string | null;
  write_acknowledged_at: Date | null; last_checked_at: Date | null; verified_at: Date | null;
  revoked_at: Date | null; revocation_reason: FingerprintRevocation['reason'] | null;
};
type CaseEvidence = {
  status: string;
  account_id: string;
  occurred_at: Date;
  session_id: string | null;
  trace: {
    risk: RiskAssessment; eventKind: PatternStep['kind']; team?: Investigation['team']; reuse?: Reuse | null;
    memoryPolicy?: { match: { publicationId: string } | null; sessionRules: string[] } | null;
  };
};
export type ActivePattern = {
  publicationId: string; memoryId: string; originCase: string; version: number;
  steps: PatternStep[]; conditions: string[];
};
export type Reuse = {
  publicationId: string; memoryId: string; originCase: string; originAgent: string;
  retrievingAgent: string; version: number; evidence: string[]; skippedAgent: string;
};
export type ProvisionalSignal = {
  memoryId: string; originCase: string; originAgent: string; receivingAgent: string;
  evidenceIds: string[]; crossSession: boolean; sourceOccurredAt: string;
};
export class FeedbackError extends Error {
  constructor(readonly code: string) { super(code); }
}

function encode(document: LearningDocument) {
  const heading = document.kind === 'fingerprint' ? FINGERPRINT_QUERY : 'ContextCon provisional specialist observation';
  return heading + '\nContextCon publication ' + document.publicationId + '\n' + JSON.stringify(document);
}

function decode(text: string | null) {
  if (!text || text.length > 6000) return;
  const json = text.split('\n').at(-1);
  if (!json) return;
  try {
    return documentSchema.safeParse(JSON.parse(json)).data;
  } catch {
    return undefined;
  }
}

function matches(risk: RiskAssessment, required: readonly string[]) {
  const current = new Set(risk.evidence.map((item) => item.id));
  return required.every((id) => current.has(id));
}

async function enqueue(db: pg.PoolClient, pack: Pack, document: LearningDocument, caseId: string) {
  await db.query(`
    INSERT INTO memory_publications (id, case_id, pack, kind, document)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING
  `, [document.publicationId, caseId, pack, document.kind, JSON.stringify(document)]);
}

export class LearningService {
  private blockedUntil = 0;

  constructor(
    private readonly pool: pg.Pool, private readonly packs: Partial<Record<Pack, MemoryGateway>>,
    private readonly timeoutMs: number, private readonly scopeConfirmed = false,
  ) {}

  hasPack(pack: Pack) { return Boolean(this.packs[pack]); }

  /**
   * Ranked playbook passages from the confirmed pack's knowledge base, bound to approved local
   * versions. Returns null when the gateway has no knowledge search (the local stand-in).
   */
  async knowledgeContext(query: string, agentId: string, limit = 4) {
    const gateway = this.packs.confirmed;
    if (!gateway?.knowledgeSearch) return null;
    const { hits } = await gateway.knowledgeSearch(query, agentId, AbortSignal.timeout(this.timeoutMs), limit);
    return { hits: hits.length, ...await bindKnowledgeHits(this.pool, hits) };
  }

  async recordObservation(db: pg.PoolClient, caseId: string, agent: AgentTrace | undefined) {
    if (!this.packs.risk || !agent?.result?.evidence.length) return;
    const originAgent = z.enum(specialists).safeParse(agent.agentId).data;
    if (!originAgent) return;
    await enqueue(db, 'risk', {
      format: 'contextcon-learning-v1', publicationId: randomUUID(), kind: 'observation',
      originCase: caseId, originAgent, feedbackCase: null, verification: 'provisional',
      version: 1, supersedes: null, evidence: agent.result.evidence.map((item) => item.id), required: [],
    }, caseId);
  }

  async feedback(caseId: string, request: Feedback) {
    if (!this.packs.confirmed) throw new FeedbackError('confirmed_pack_unconfigured');
    return inTransaction(this.pool, async (db) => {
      const row = (await db.query<CaseEvidence>(`
        SELECT c.status, c.trace, e.account_id, e.occurred_at, e.payload->>'sessionId' AS session_id
        FROM cases c JOIN events e ON e.id = c.id WHERE c.id = $1 FOR UPDATE OF c
      `, [caseId])).rows[0];
      if (!row || row.status !== 'decided') throw new FeedbackError('decided_case_required');
      const canonical = JSON.stringify(request);
      const previous = (await db.query<{ same: boolean; publication_id: string | null }>(
        'SELECT request = $2::jsonb AS same, publication_id FROM analyst_feedback WHERE case_id = $1', [caseId, canonical],
      )).rows[0];
      if (previous) {
        if (!previous.same) throw new FeedbackError('feedback_conflict');
        return (await db.query<Publication>(`
          SELECT * FROM memory_publications WHERE id = $1 OR ($1::uuid IS NULL AND case_id = $2 AND kind = 'fingerprint')
        `, [previous.publication_id, caseId])).rows[0]!;
      }
      const session = [
        ...await loadSessionSteps(db, {
          accountId: row.account_id, occurredAt: row.occurred_at.toISOString(), sessionId: row.session_id, excludeId: caseId,
        }),
        currentStep(row.trace.eventKind, row.trace.risk.evidence),
      ];

      let document: LearningDocument;
      const publicationId = randomUUID();
      if (request.verdict === 'fraud_confirmed') {
        const steps = compactSteps(session);
        const sequence = steps.length >= MIN_MATCHED_STEPS && stepPoints(session) >= MIN_MATCHED_POINTS
          ? { steps, conditions: [] } : null;
        const origin = row.trace.team?.find((item) => item.agentId === LOGIN_AGENT);
        const signatureCase = row.trace.eventKind === 'transfer' && matches(row.trace.risk, signature) &&
          origin?.result?.evidenceIds.includes('behaviour_shift');
        const base = {
          format: 'contextcon-learning-v1' as const, publicationId, kind: 'fingerprint' as const, originCase: caseId,
          feedbackCase: caseId, verification: 'analyst_confirmed' as const, version: 1, supersedes: null,
        };
        if (signatureCase) {
          // The specialist-verified transfer signature keeps its original meaning for agent reuse.
          document = {
            ...base, originAgent: LOGIN_AGENT, evidence: row.trace.risk.evidence.map((item) => item.id), required: [...signature],
            ...(sequence ? { pattern: 'transfer_signature' as const, ...sequence } : {}),
          };
        } else if (sequence) {
          // A repeat confirmation of known steps corroborates the active pattern rather than
          // adding a copy, so one correction or revocation governs every identical attack.
          // Concurrent confirmations of the same steps serialize on this transaction lock.
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2))', [JSON.stringify(sequence.steps)]);
          const existing = (await db.query<Publication>(`
            SELECT * FROM memory_publications
            WHERE pack = 'confirmed' AND kind = 'fingerprint' AND state <> 'failed'
              AND superseded_at IS NULL AND revoked_at IS NULL
              AND document->>'pattern' = 'session_sequence' AND document->'steps' = $1::jsonb
            ORDER BY id LIMIT 1
          `, [JSON.stringify(sequence.steps)])).rows[0];
          if (existing) {
            await db.query('INSERT INTO analyst_feedback (case_id, request, publication_id) VALUES ($1, $2, $3)', [caseId, canonical, existing.id]);
            return existing;
          }
          document = {
            ...base, originAgent: INVESTIGATOR_AGENT, evidence: sessionRules(sequence.steps).slice(0, 16), required: [],
            pattern: 'session_sequence', ...sequence,
          };
        } else {
          throw new FeedbackError('case_outside_supported_pattern');
        }
      } else {
        const old = (await db.query<Publication>(`
          SELECT * FROM memory_publications WHERE id = $1 AND pack = 'confirmed'
            AND state = 'published' AND superseded_at IS NULL AND revoked_at IS NULL FOR UPDATE
        `, [request.publicationId])).rows[0];
        const require = request.require;
        const viaReuse = Boolean(old) && row.trace.reuse?.publicationId === old!.id;
        const viaPolicy = Boolean(old?.document.steps) && row.trace.memoryPolicy?.match?.publicationId === old!.id;
        // A correction names a rule the original attack had and this legitimate case lacked.
        const supported = old && old.document.originCase !== caseId && old.document.evidence.includes(require) && (
          viaReuse ? !old.document.required.includes(require) && matches(row.trace.risk, old.document.required) &&
            !matches(row.trace.risk, [require]) :
          viaPolicy ? !(old.document.conditions ?? []).includes(require) &&
            !(row.trace.memoryPolicy?.sessionRules ?? sessionRules(session)).includes(require) :
          false);
        if (!old || !supported) throw new FeedbackError('correction_not_supported_by_evidence');
        await db.query('UPDATE memory_publications SET superseded_at = clock_timestamp() WHERE id = $1', [old.id]);
        document = { ...old.document, publicationId, feedbackCase: caseId, supersedes: old.id,
          version: old.document.version + 1,
          required: old.document.pattern === 'session_sequence' ? old.document.required : [...old.document.required, require],
          ...(old.document.steps ? { conditions: [...(old.document.conditions ?? []), require] } : {}),
        };
      }
      await enqueue(db, 'confirmed', document, caseId);
      await db.query('INSERT INTO analyst_feedback (case_id, request, publication_id) VALUES ($1, $2, $3)', [caseId, canonical, publicationId]);
      return (await db.query<Publication>('SELECT * FROM memory_publications WHERE id = $1', [publicationId])).rows[0]!;
    });
  }

  async revokeFingerprint(publicationId: string, reason: FingerprintRevocation['reason']) {
    const result = await this.pool.query<Publication>(`
      UPDATE memory_publications
      SET revoked_at = COALESCE(revoked_at, clock_timestamp()), revocation_reason = $2
      WHERE id = $1 AND pack = 'confirmed' AND state = 'published' AND superseded_at IS NULL
        AND (revoked_at IS NULL OR revocation_reason = $2)
      RETURNING *
    `, [publicationId, reason]);
    const row = result.rows[0];
    if (!row) throw new FeedbackError('fingerprint_revocation_not_applicable');
    return row;
  }

  async pubs(caseId: string) {
    return (await this.pool.query<Publication>('SELECT * FROM memory_publications WHERE case_id = $1 ORDER BY kind', [caseId])).rows;
  }

  async recall(pack: Pack, query: string, agentId: string) {
    const gateway = this.packs[pack];
    if (!gateway) return;
    if (pack !== 'confirmed' || !this.scopeConfirmed) {
      return { ...await gateway.search(query, agentId, AbortSignal.timeout(this.timeoutMs)), lookup: 'search' as const };
    }

    // Demo schemas own their pointer registry. Fetch the evidence from Meko, including
    // superseded versions so the same validation path records why D rejected them.
    const pointers = (await this.pool.query<{ remote_id: string }>(`
      SELECT remote_id FROM memory_publications WHERE pack = 'confirmed' AND state = 'published'
      ORDER BY (superseded_at IS NULL AND revoked_at IS NULL) DESC, verified_at DESC LIMIT 10
    `)).rows;
    const signal = AbortSignal.timeout(this.timeoutMs);
    const records = (await Promise.all(pointers.map(({ remote_id }) => gateway.read(remote_id, agentId, signal))))
      .filter((record) => record !== null);
    return { records, matches: records.map(({ id }) => ({ id, score: null })), lookup: 'exact_id' as const };
  }

  async previousSignals(caseId: string, receivingAgent: string): Promise<ProvisionalSignal[]> {
    const gateway = this.packs.risk;
    if (!gateway) return [];
    const candidates = await this.pool.query<{
      document: LearningDocument; remote_id: string; cross_session: boolean; occurred_at: Date;
    }>(`
      SELECT p.document, p.remote_id, COALESCE(src.payload->>'sessionId' <> target.payload->>'sessionId', false) AS cross_session,
        src.occurred_at
      FROM cases current_case
      JOIN events target ON target.id = current_case.id
      JOIN events src ON src.account_id = target.account_id
        AND src.occurred_at < LEAST(target.occurred_at, current_case.created_at)
        AND src.occurred_at >= LEAST(target.occurred_at, current_case.created_at) - interval '30 minutes'
      JOIN memory_publications p ON p.case_id = src.id AND p.pack = 'risk' AND p.kind = 'observation'
        AND p.state = 'published' AND p.superseded_at IS NULL AND p.verified_at <= current_case.created_at
      WHERE current_case.id = $1 AND p.document->>'originAgent' <> $2
      ORDER BY src.occurred_at DESC, p.id LIMIT 2
    `, [caseId, receivingAgent]);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const records = await Promise.all(candidates.rows.map(async (candidate): Promise<ProvisionalSignal | null> => {
      const record = await gateway.read(candidate.remote_id, receivingAgent, signal);
      if (record?.id !== candidate.remote_id || record.text !== encode(candidate.document)) return null;
      const document = decode(record.text);
      if (document?.kind !== 'observation' || document.verification !== 'provisional') return null;
      return {
        memoryId: record.id, originCase: document.originCase, originAgent: document.originAgent, receivingAgent,
        evidenceIds: document.evidence, crossSession: candidate.cross_session, sourceOccurredAt: candidate.occurred_at.toISOString(),
      };
    }));
    return records.filter((record) => record !== null);
  }

  async validateRecall(caseId: string, risk: RiskAssessment, result: { records: RecordHit[] }, pointInTime = false) {
    const rejected: { memoryId: string; reason: string }[] = [];
    let reuse: Reuse | null = null;
    for (const hit of result.records) {
      const document = decode(hit.text);
      if (!hit.id || !document || document.kind !== 'fingerprint' || document.verification !== 'analyst_confirmed') continue;
      // Session patterns drive the deterministic policy; only transfer signatures let an agent skip review.
      if (document.pattern === 'session_sequence') continue;
      const published = (await this.pool.query<{ active: boolean; revoked: boolean; exact: boolean; fresh: boolean; distinct_account: boolean; known_at_event: boolean }>(`
        SELECT m.superseded_at IS NULL AS active, m.revoked_at IS NOT NULL AS revoked, document = $3::jsonb AS exact,
          m.verified_at >= clock_timestamp() - interval '30 days' AS fresh,
          source.account_id <> target.account_id AS distinct_account,
          (source.occurred_at < LEAST(target.occurred_at, target_case.created_at)
            AND m.verified_at <= target_case.created_at) AS known_at_event
        FROM memory_publications m
        JOIN events source ON source.id = $4
        JOIN events target ON target.id = $5
        JOIN cases target_case ON target_case.id = target.id
        WHERE m.id = $1 AND remote_id = $2 AND pack = 'confirmed' AND state = 'published'
      `, [document.publicationId, hit.id, JSON.stringify(document), document.originCase, caseId])).rows[0];
      const reason = !published?.exact ? 'unverified' : published.revoked ? 'revoked' : !published.active ? 'superseded' :
        pointInTime && !published.known_at_event ? 'unavailable_at_event' :
        !published.fresh ? 'stale' : !published.distinct_account ? 'same_account' : !matches(risk, document.required) ? 'conditions_not_met' : null;
      if (reason) {
        rejected.push({ memoryId: hit.id, reason });
        continue;
      }
      reuse ??= {
        publicationId: document.publicationId, memoryId: hit.id, originCase: document.originCase,
        originAgent: document.originAgent, retrievingAgent: TRANSFER_AGENT, version: document.version,
        evidence: document.required, skippedAgent: LOGIN_AGENT,
      };
    }
    return { reuse, rejected };
  }

  async workOne(publicationId?: string, attemptLimit = 10) {
    if (Date.now() < this.blockedUntil) return null;
    const configured = (['risk', 'confirmed'] as const).filter((pack) => this.packs[pack]);
    const job = (await this.pool.query<Publication & { previous: Publication['state'] }>(`
      WITH candidate AS (
        SELECT id, state FROM memory_publications
        WHERE pack = ANY($1::text[]) AND state IN ('pending', 'sending', 'indexing', 'uncertain')
          AND attempts < $3 AND next_check_at <= clock_timestamp()
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY (state <> 'pending'), next_check_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE memory_publications m SET
        state = CASE WHEN candidate.state = 'pending' THEN 'sending' ELSE candidate.state END,
        attempts = m.attempts + 1, next_check_at = clock_timestamp() + interval '90 seconds'
      FROM candidate WHERE m.id = candidate.id RETURNING m.*, candidate.state AS previous
    `, [configured, publicationId ?? null, attemptLimit])).rows[0];
    if (!job) return null;
    const gateway = this.packs[job.pack]!;
    let remoteId = job.remote_id;
    let state: Publication['state'] = job.previous === 'indexing' ? 'indexing' : 'uncertain';
    let operation = job.previous === 'pending' ? 'write' : remoteId ? 'exact_id' : 'marker_search';
    let error: string | null = null;
    let acknowledged = false;
    let rateLimited = false;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let delayMs = Math.min(60_000, 2000 * 2 ** Math.min(5, job.attempts - 1));
    try {
      const expected = encode(job.document);
      if (operation === 'write') {
        remoteId = await gateway.write(expected, job.document.originAgent, signal);
        state = 'indexing';
        acknowledged = true;
      } else {
        let records = remoteId
          ? [await gateway.read(remoteId, job.document.originAgent, signal)]
          : (await gateway.search('ContextCon publication ' + job.id, job.document.originAgent, signal)).records;
        const findExpected = () => records.find((hit) => hit?.id && (!remoteId || hit.id === remoteId) && hit.text === expected);
        let stored = findExpected();
        if (!stored && !remoteId) {
          operation = 'recent_inventory';
          records = await gateway.recent(job.document.originAgent, signal);
          stored = findExpected();
        }
        if (stored?.id) {
          remoteId = stored.id;
          state = 'published';
        } else {
          error = remoteId && records.some((hit) => hit?.id === remoteId)
            ? 'document_mismatch' : 'not_visible';
        }
      }
    } catch (failure) {
      error = failureCode(failure, signal, 'remote_publication_error');
      if (failure instanceof MekoWriteNotSent) {
        state = /meko_http_(401|403|404)|meko_unrecognized_response/.test(failure.code) ? 'failed' : 'pending';
      }
      if (failure instanceof MekoRateLimit || failure instanceof MekoWriteNotSent && failure.retryAfterMs !== undefined) {
        delayMs = Math.max(delayMs, failure.retryAfterMs ?? 60_000);
        this.blockedUntil = Date.now() + delayMs;
        rateLimited = true;
      }
    }
    const updated = await this.pool.query<Publication>(`
      UPDATE memory_publications SET state = $2, remote_id = $3, last_error = $4,
        next_check_at = clock_timestamp() + $6::double precision * interval '1 millisecond',
        verified_at = CASE WHEN $2 = 'published' THEN clock_timestamp() ELSE verified_at END,
        write_acknowledged_at = CASE WHEN $7 THEN clock_timestamp() ELSE write_acknowledged_at END,
        last_operation = $8, last_checked_at = clock_timestamp()
      WHERE id = $1 AND attempts = $5 RETURNING *
    `, [job.id, state, remoteId, error, job.attempts, delayMs, acknowledged, operation]);
    if (rateLimited) {
      await this.pool.query(`
        UPDATE memory_publications
        SET next_check_at = GREATEST(next_check_at, clock_timestamp() + $1::double precision * interval '1 millisecond')
        WHERE pack = ANY($2::text[]) AND state IN ('pending', 'sending', 'indexing', 'uncertain')
      `, [delayMs, configured]);
    }
    return updated.rows[0] ?? null;
  }
}

/**
 * Analyst-confirmed session patterns that the publication worker has read back from the
 * confirmed datapack, as known before this event. The table is the local verified mirror
 * of that datapack, so the deterministic path needs no network call per event.
 */
export async function activePatterns(db: Pick<pg.PoolClient, 'query'>, accountId: string, occurredAt: string): Promise<ActivePattern[]> {
  const rows = (await db.query<{ id: string; remote_id: string; document: unknown }>(`
    SELECT m.id, m.remote_id, m.document
    FROM memory_publications m JOIN events source ON source.id = (m.document->>'originCase')::uuid
    WHERE m.pack = 'confirmed' AND m.kind = 'fingerprint' AND m.state = 'published'
      AND m.superseded_at IS NULL AND m.revoked_at IS NULL AND m.document ? 'steps'
      AND m.verified_at <= clock_timestamp() AND m.verified_at >= clock_timestamp() - make_interval(days => $3)
      AND source.account_id <> $1 AND source.occurred_at < $2::timestamptz
    ORDER BY m.verified_at DESC, m.id LIMIT 200
  `, [accountId, occurredAt, PATTERN_FRESHNESS_DAYS])).rows;
  return rows.flatMap((row) => {
    const document = documentSchema.safeParse(row.document).data;
    if (!document?.steps || document.publicationId !== row.id || document.verification !== 'analyst_confirmed') return [];
    return [{
      publicationId: row.id, memoryId: row.remote_id, originCase: document.originCase, version: document.version,
      steps: document.steps, conditions: document.conditions ?? [],
    }];
  });
}

export type PatternDecision = {
  candidates: number;
  conditionsUnmet: number;
  sessionRules: string[];
  match: (PatternMatch & Omit<ActivePattern, 'steps' | 'conditions'>) | null;
};

/** Compare the current session with every active verified pattern. Deterministic and local. */
export async function evaluateVerifiedPatterns(
  db: Pick<pg.PoolClient, 'query'>, event: { id: string; kind: PatternStep['kind']; accountId: string; timestamp: string; sessionId?: string },
  evidence: RiskAssessment['evidence'],
): Promise<PatternDecision> {
  const patterns = await activePatterns(db, event.accountId, event.timestamp);
  if (!patterns.length) return { candidates: 0, conditionsUnmet: 0, sessionRules: [], match: null };
  const session = [
    ...await loadSessionSteps(db, { accountId: event.accountId, occurredAt: event.timestamp, sessionId: event.sessionId, excludeId: event.id }),
    currentStep(event.kind, evidence),
  ];
  const rules = sessionRules(session);
  let conditionsUnmet = 0;
  let best: PatternDecision['match'] = null;
  for (const pattern of patterns) {
    if (!pattern.conditions.every((id) => rules.includes(id))) {
      conditionsUnmet++;
      continue;
    }
    const found = matchPattern(pattern.steps, session);
    if (!found) continue;
    if (!best || found.matchedSteps > best.matchedSteps || (found.matchedSteps === best.matchedSteps && found.points > best.points)) {
      const { steps: _steps, conditions: _conditions, ...source } = pattern;
      best = { ...source, ...found };
    }
  }
  return { candidates: patterns.length, conditionsUnmet, sessionRules: rules, match: best };
}
