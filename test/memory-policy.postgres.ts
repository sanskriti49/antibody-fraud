import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CaseService } from '../src/cases.js';
import { createPool, migrate } from '../src/database.js';
import { generateEarlyCorpus, type EarlyScenario } from '../src/early-scenarios.js';
import type { FraudEvent } from '../src/events.js';
import { localMemoryGateway } from '../src/integrations/local-memory.js';
import { FeedbackError, LearningService } from '../src/learning.js';
import type { MemoryPolicyMode } from '../src/memory-policy.js';

const endpoint = process.env.TEST_DATABASE_URL;
if (!endpoint) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = 'contextcon_memory_policy_test_' + randomUUID().replaceAll('-', '');
const policy = { challenge: 25, block: 72 };
let admin: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  admin = createPool(endpoint);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(endpoint, '-c search_path=' + schema);
  await migrate(pool);
});
beforeEach(async () => {
  // All rows belong to this suite's disposable isolated schema.
  await pool.query('TRUNCATE analyst_feedback, memory_publications, cases, events');
});
afterAll(async () => {
  await pool?.end();
  if (admin) {
    try {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.end();
    }
  }
});

function cases(memoryPolicy: MemoryPolicyMode) {
  return new CaseService(pool, policy, { mode: 'rules', advanced: true, memoryTimeoutMs: 250, modelTimeoutMs: 250, memoryPolicy });
}

/** Episodes of one synthetic scenario, each on its own account, in stream order. */
function episodes(scenario: EarlyScenario, seed = 7403) {
  const corpus = generateEarlyCorpus({ split: 'evaluation', seed, maxEvents: 160, scenario });
  return corpus.episodes.map((episode) => {
    const events = corpus.events.filter((event) => corpus.labels.get(event.id)?.episodeId === episode.id);
    return { events, impactId: episode.impactId, last: events.at(-1)! };
  });
}

async function ingestAll(events: FraudEvent[], service: CaseService) {
  const actions = new Map<FraudEvent['kind'], string[]>();
  for (const event of events) {
    const { case: row } = await service.ingest(event);
    actions.set(event.kind, [...actions.get(event.kind) ?? [], row.action!]);
  }
  return actions;
}

async function settle(learning: LearningService, publicationId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await pool.query('UPDATE memory_publications SET next_check_at = clock_timestamp() WHERE id = $1', [publicationId]);
    const row = await learning.workOne(publicationId);
    if (row?.state === 'published') return row;
  }
  throw new Error('Publication did not settle');
}

async function caseRow(id: string) {
  return (await pool.query('SELECT action, trace FROM cases WHERE id = $1', [id])).rows[0];
}

describe('verified-pattern policy', () => {
  it('learns a confirmed takeover and blocks another account at its password reset', async () => {
    const learning = new LearningService(pool, { confirmed: localMemoryGateway() }, 250);
    const [first, second, third] = episodes('takeover');
    await ingestAll(first!.events, cases('enforce'));
    const publication = await learning.feedback(first!.impactId!, { verdict: 'fraud_confirmed' });
    expect(publication.document).toMatchObject({ pattern: 'session_sequence', originAgent: 'contextcon-investigator', conditions: [] });
    expect(publication.document.steps?.map((item) => item.kind)).toEqual(['login', 'password_reset', 'payee_added', 'transfer']);

    // Unpublished knowledge is unusable even though the row exists locally.
    const shadowBeforePublish = await ingestAll(second!.events.slice(0, -2), cases('shadow'));
    expect(shadowBeforePublish.get('password_reset')?.at(-1)).toBe('ALLOW');
    await settle(learning, publication.id);

    const actions = await ingestAll(second!.events.slice(-2), cases('shadow'));
    const shadow = await caseRow(second!.events.at(-2)!.id);
    expect(actions.get('payee_added')).toEqual(['STEP_UP_VERIFICATION']);
    expect(shadow.trace.memoryPolicy).toMatchObject({ mode: 'shadow', applied: false, wouldAction: 'BLOCK', match: { matchedSteps: 3 } });

    const enforced = await ingestAll(third!.events, cases('enforce'));
    expect(enforced.get('password_reset')?.at(-1)).toBe('BLOCK');
    const reset = await caseRow(third!.events.find((event) => event.kind === 'password_reset' && event.sessionId?.endsWith('-current'))!.id);
    expect(reset.trace.rationale).toContain('analyst-confirmed attack pattern');
    expect(reset.trace.memoryPolicy).toMatchObject({
      mode: 'enforce', applied: true, match: { publicationId: publication.id, originCase: first!.impactId, matchedSteps: 2 },
    });
    expect(reset.trace.risk.evidence.at(-1)).toMatchObject({ id: 'verified_pattern_match', provenance: 'verified_memory' });
  });

  it('corroborates identical confirmations instead of copying the pattern', async () => {
    const learning = new LearningService(pool, { confirmed: localMemoryGateway() }, 250);
    const [first, second] = episodes('takeover');
    await ingestAll(first!.events, cases('off'));
    await ingestAll(second!.events, cases('off'));
    const original = await learning.feedback(first!.impactId!, { verdict: 'fraud_confirmed' });
    const repeat = await learning.feedback(second!.impactId!, { verdict: 'fraud_confirmed' });
    const replay = await learning.feedback(second!.impactId!, { verdict: 'fraud_confirmed' });
    expect([repeat.id, replay.id]).toEqual([original.id, original.id]);
    expect((await pool.query('SELECT count(*)::int AS count FROM memory_publications')).rows[0].count).toBe(1);
  });

  it('lets an analyst narrow a pattern that blocked a legitimate customer, then revoke it', async () => {
    const learning = new LearningService(pool, { confirmed: localMemoryGateway() }, 250);
    const [attack, laterAttack] = episodes('takeover');
    // Episode 0 of each scenario shares a start time, so the customers begin after the attack.
    const [, customer, laterCustomer] = episodes('legitimate-recovery');
    await ingestAll(attack!.events, cases('enforce'));
    const original = await settle(learning, (await learning.feedback(attack!.impactId!, { verdict: 'fraud_confirmed' })).id);

    const blocked = await ingestAll(customer!.events, cases('enforce'));
    expect(blocked.get('password_reset')?.at(-1)).toBe('BLOCK');
    const resetId = customer!.events.findLast((event) => event.kind === 'password_reset')!.id;
    await expect(learning.feedback(resetId, { verdict: 'legitimate_correction', publicationId: original.id, require: 'behaviour_shift' }))
      .rejects.toThrow(FeedbackError);
    const correction = await learning.feedback(resetId, { verdict: 'legitimate_correction', publicationId: original.id, require: 'amount_spike' });
    expect(correction.document).toMatchObject({ version: 2, supersedes: original.id, conditions: ['amount_spike'] });
    await settle(learning, correction.id);

    const relieved = await ingestAll(laterCustomer!.events, cases('enforce'));
    expect([...relieved.values()].flat()).not.toContain('BLOCK');
    const attackAfterCorrection = await ingestAll(laterAttack!.events, cases('enforce'));
    expect(attackAfterCorrection.get('password_reset')?.at(-1)).not.toBe('BLOCK');
    expect(attackAfterCorrection.get('transfer')?.at(-1)).toBe('BLOCK');

    await learning.revokeFingerprint(correction.id, 'incorrect_generalization');
    const [, , afterRevoke] = episodes('takeover');
    const revoked = await ingestAll(afterRevoke!.events, cases('enforce'));
    expect([...revoked.values()].flat()).not.toContain('BLOCK');
  });

  it('records nothing when the policy is off and never matches the origin account', async () => {
    const learning = new LearningService(pool, { confirmed: localMemoryGateway() }, 250);
    const [first, second] = episodes('takeover');
    await ingestAll(first!.events, cases('off'));
    await settle(learning, (await learning.feedback(first!.impactId!, { verdict: 'fraud_confirmed' })).id);
    await ingestAll(second!.events, cases('off'));
    expect((await caseRow(second!.last.id)).trace.memoryPolicy).toBeUndefined();

    const sameAccount = first!.events.map((event) => ({
      ...event, id: randomUUID(), timestamp: new Date(Date.parse(event.timestamp) + 3_600_000).toISOString(),
    }));
    await ingestAll(sameAccount, cases('enforce'));
    expect((await caseRow(sameAccount.at(-1)!.id)).trace.memoryPolicy).toMatchObject({ candidates: 0, match: null });
  });
});
