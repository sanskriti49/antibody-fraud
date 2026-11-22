import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { CaseService } from '../src/cases.js';
import { createPool, migrate } from '../src/database.js';
import type { FraudEvent } from '../src/events.js';
import type { InvestigationOptions } from '../src/investigation.js';
import { DependencyError, type StructuredModel } from '../src/integrations/ports.js';
import { MekoRateLimit, MekoWriteNotSent } from '../src/integrations/meko.js';
import { LearningService, LOGIN_AGENT, TRANSFER_AGENT, type MemoryGateway } from '../src/learning.js';
import { generateScenario, type Scenario } from '../src/simulator.js';

const connection = process.env.TEST_DATABASE_URL;
if (!connection) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database. See MANUAL_SETUP.md.');

const schema = 'contextcon_test_' + randomUUID().replaceAll('-', '');
let admin: pg.Pool;
let pool: pg.Pool;
const servers: Server[] = [];
const policy = { challenge: 25, block: 72 };

beforeAll(async () => {
  admin = createPool(connection);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(connection, '-c search_path=' + schema);
  expect(await migrate(pool)).toEqual(['001_events_cases.sql', '002_collective_learning.sql', '003_publication_reconciliation.sql', '005_graph_indexes.sql', '006_fingerprint_revocation.sql', '007_feedback_publication.sql', '008_playbooks.sql']);
  expect(await migrate(pool)).toEqual([]);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
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

function service(overrides?: Partial<InvestigationOptions>) {
  return new CaseService(pool, policy, {
    mode: 'rules', memoryTimeoutMs: 250, modelTimeoutMs: 250, ...overrides,
  });
}

async function replay(seed: number, scenario: Scenario, cases = service()) {
  const events = generateScenario(seed, scenario).events;
  const last = events.at(-1)!;
  for (const prior of events.slice(0, -1)) await cases.ingest(prior);
  return last;
}

async function startApi(cases = service(), learning?: LearningService) {
  const server = createApp(pool, cases, learning).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Expected a TCP address');
  const base = 'http://127.0.0.1:' + addr.port;
  return {
    get: (path: string) => fetch(base + path),
    post: (event: unknown, path = '/api/events') => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    }),
  };
}

const usage = { inputTokens: 120, outputTokens: 45, reasoningTokens: null, totalTokens: 165 };
const accepted = {
  riskScore: 55, confidence: 0.7, evidenceIds: ['behaviour_shift'], missingContext: ['No independent challenge'],
  recommendedAction: 'ALLOW', rationale: 'Timing changed across multiple measured signals.',
};

function fakeModel(generate: StructuredModel['generate']): StructuredModel {
  return { provider: 'test-double', model: 'fixture', generate };
}

describe('real PostgreSQL and HTTP', () => {
  it('validates ingestion, appends a decision, and preserves it on concurrent duplicate requests', async () => {
    const model = fakeModel(vi.fn());
    const api = await startApi(service({ mode: 'agents', model }));
    expect((await api.get('/health')).status).toBe(200);
    const event = generateScenario(100, 'ordinary').events[0]!;
    expect((await api.post({ ...event, fraud: false })).status).toBe(400);
    const responses = await Promise.all(Array.from({ length: 12 }, () => api.post(event)));
    expect(responses.map((response) => response.status).sort()).toEqual([...Array(11).fill(200), 201]);
    const read = await (await api.get('/api/cases/' + event.id)).json();
    expect(read).toMatchObject({ id: event.id, action: 'ALLOW', trace: { path: 'fast', modelCalls: 0, action: 'ALLOW' } });
    expect(model.generate).not.toHaveBeenCalled();
    expect((await api.post({ ...event, networkId: 'net-different' })).status).toBe(409);
    for (const table of ['events', 'cases']) {
      expect((await pool.query('SELECT count(*)::int AS count FROM ' + table + ' WHERE id = $1', [event.id]))
        .rows[0].count).toBe(1);
    }
  });

  it('uses preceding failure, travel and behavioural features to block on the fast path', async () => {
    const calls = vi.fn();
    const cases = service({ mode: 'meko', memory: { search: calls }, model: fakeModel(calls) });
    const event = await replay(101, 'credential-stuffing', cases);
    const result = (await cases.ingest(event)).case;
    expect(result.action).toBe('BLOCK');
    expect(result.trace.features).toMatchObject({ failedLogins15m: 3, newDevice: true, behaviourOutliers: 3 });
    expect(result.trace.risk.evidence.map((item) => item.id)).toContain('impossible_travel');
    expect(result.trace.path).toBe('fast');
    expect(calls).not.toHaveBeenCalled();
  });

  it('excludes future or same-timestamp rows even when they arrive first', async () => {
    const cases = service();
    const [event] = generateScenario(102, 'ordinary').events;
    const base = event!;
    for (const offset of [0, 1000, 2000, 3000]) {
      const observation = {
        ...base, kind: 'login_failed', id: randomUUID(),
        timestamp: new Date(Date.parse(base.timestamp) + offset).toISOString(),
      } satisfies FraudEvent;
      await cases.ingest(observation);
    }
    expect((await cases.ingest(base)).case.trace.features).toMatchObject({ historyCount30d: 0, failedLogins15m: 0 });
  });

  it('keeps legitimate travel allowable and recognizes velocity and shared identifiers', async () => {
    const cases = service();
    const legitimate = (await cases.ingest(await replay(103, 'legitimate-travel'))).case;
    expect(legitimate.action).toBe('ALLOW');
    const velocity = (await cases.ingest(await replay(104, 'velocity'))).case;
    expect(velocity.trace.features.transfers10m).toBe(3);
    expect(velocity.action).toBe('STEP_UP_VERIFICATION');
    const shared = (await cases.ingest(await replay(105, 'shared-identifiers'))).case;
    expect(shared.trace.features).toMatchObject({ sharedDeviceAccounts24h: 2, sharedNetworkAccounts24h: 2 });
  });

  it('traces a valid specialist result and retries a forged evidence reference only once', async () => {
    const event = await replay(106, 'takeover');
    const generate = vi.fn<StructuredModel['generate']>()
      .mockResolvedValueOnce({ text: JSON.stringify({ ...accepted, evidenceIds: ['forged'] }), usage })
      .mockResolvedValueOnce({ text: JSON.stringify(accepted), usage });
    const cases = service({ mode: 'agents', model: fakeModel(generate) });
    const result = (await cases.ingest(event)).case;
    expect(result.action).toBe('STEP_UP_VERIFICATION');
    expect(result.trace).toMatchObject({
      path: 'agent_review', modelCalls: 2, policy: { agentRecommendation: 'ALLOW', appliedAction: 'STEP_UP_VERIFICATION' },
      agent: { result: { caseId: event.id, evidenceIds: ['behaviour_shift'] },
        attempts: [{ status: 'rejected', error: 'invalid_agent_result', usage }, { status: 'accepted', usage }] },
    });
    expect(generate.mock.calls[0]?.[1]).not.toContain(event.accountId);
    expect(generate.mock.calls[0]?.[1]).not.toContain('fraud');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('filters retrieval context from the model and traces ID and score instead', async () => {
    const event = await replay(107, 'takeover');
    const id = randomUUID();
    const search = vi.fn().mockResolvedValue({ matches: [{ id, score: 0.81 }] });
    const generate = vi.fn<StructuredModel['generate']>().mockResolvedValue({ text: JSON.stringify(accepted), usage });
    const cases = service({ mode: 'meko', memory: { search }, model: fakeModel(generate) });
    const result = (await cases.ingest(event)).case;
    expect(result.trace.context).toMatchObject({ status: 'ok', matches: [{ id, score: 0.81 }] });
    expect(result.trace.agent?.result?.retrievedMemoryIds).toEqual([]);
    expect(search.mock.calls[0]?.[0]).not.toContain(event.accountId);
    expect(generate.mock.calls[0]?.[1]).not.toContain(id);
  });

  it('falls back for Meko failures without a model call and for a timed-out model', async () => {
    const event = await replay(108, 'takeover');
    const generate = vi.fn<StructuredModel['generate']>();
    const cases = service({
      mode: 'meko', model: fakeModel(generate),
      memory: { search: async () => { throw new DependencyError('meko_http_429'); } },
    });
    const meko = (await cases.ingest(event)).case;
    expect(meko.action).toBe('STEP_UP_VERIFICATION');
    expect(meko.trace).toMatchObject({ path: 'fallback', modelCalls: 0, context: { error: 'meko_http_429' } });
    expect(generate).not.toHaveBeenCalled();

    const timeoutEvent = await replay(109, 'takeover');
    const timeoutCases = service({
      mode: 'agents', model: fakeModel(async (_instruction, _data, _schema, signal) => {
        await once(signal, 'abort');
        throw signal.reason;
      }),
    });
    const model = (await timeoutCases.ingest(timeoutEvent)).case;
    expect(model.action).toBe('STEP_UP_VERIFICATION');
    expect(model.trace).toMatchObject({ path: 'fallback', modelCalls: 1, agent: { attempts: [{ error: 'timeout' }] } });
  });

  it('keeps one decision while a duplicate request arrives during an investigation', async () => {
    const event = await replay(110, 'takeover');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const generate = vi.fn<StructuredModel['generate']>(async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify(accepted), usage };
    });
    const api = await startApi(service({ mode: 'agents', model: fakeModel(generate) }));
    const initial = api.post(event);
    await Promise.race([entered.promise, initial.then(() => { throw new Error('Agent did not start'); })]);
    try {
      expect((await api.post(event)).status).toBe(202);
    } finally {
      release.resolve();
    }
    expect((await initial).status).toBe(201);
    expect((await api.post(event)).status).toBe(200);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired lease using the original feature snapshot and fences the previous writer', async () => {
    const event = await replay(111, 'takeover');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const old = service({ mode: 'agents', model: fakeModel(async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify(accepted), usage };
    }) }).ingest(event);
    await Promise.race([entered.promise, old.then(() => { throw new Error('Agent did not start'); })]);
    try {
      await pool.query("UPDATE cases SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [event.id]);
      const recovered = await service({ mode: 'agents' }).ingest(event);
      expect(recovered.case.trace).toMatchObject({ path: 'fallback', leaseRecoveries: 1, features: { behaviourOutliers: 3 } });
    } finally {
      release.resolve();
    }
    expect((await old).case.trace.path).toBe('fallback');
  });
});

function remoteMemory() {
  const stored: { id: string; text: string }[] = [];
  const search = vi.fn<MemoryGateway['search']>(async () => ({
    records: stored, matches: stored.map(({ id }) => ({ id, score: 0.98 })),
  }));
  const write = vi.fn<MemoryGateway['write']>(async (text) => {
    const id = randomUUID();
    stored.push({ id, text });
    return id;
  });
  const read = vi.fn<MemoryGateway['read']>(async (id) => stored.find((row) => row.id === id) ?? null);
  const recent = vi.fn<MemoryGateway['recent']>(async () => stored);
  return { stored, search, read, recent, write };
}

const collectiveModel = fakeModel(async (_instruction, data) => {
  const parsed = JSON.parse(data);
  if (parsed.specialistResults) {
    return { text: JSON.stringify({ recommendedAction: 'ALLOW', rationale: 'This is a test-double synthesis.' }), usage };
  }
  const evidence = parsed.evidence as { id: string }[];
  return { text: JSON.stringify({ ...accepted, evidenceIds: evidence.slice(0, 2).map((item) => item.id) }), usage };
});

async function transferCase(seed: number, learning: LearningService, legitimate = false) {
  const events = generateScenario(seed, 'takeover').events;
  for (const prior of events.slice(0, -1)) {
    if (!legitimate || prior.kind !== 'password_reset') await service().ingest(prior);
  }
  const result = await service({ mode: 'meko', collective: true, learning, model: collectiveModel }).ingest(events.at(-1)!);
  return result.case;
}

async function makeJobsDue() {
  await pool.query("UPDATE memory_publications SET next_check_at = clock_timestamp() - interval '5 seconds' WHERE state <> 'published'");
}

async function drainJobs(learning: LearningService) {
  for (let i = 0; i < 24; i++) {
    await makeJobsDue();
    if (!await learning.workOne()) return;
  }
  throw new Error('The test-double queue did not drain.');
}

describe('PostgreSQL publication workflow with explicit remote test doubles', () => {
  beforeEach(async () => {
    // This pool is scoped to a disposable, randomly named test schema.
    await pool.query('TRUNCATE analyst_feedback, memory_publications');
  });
  it('separates unpublished observations, verifies cross-agent reuse and rejects corrected memories', async () => {
    const confirmed = remoteMemory();
    const risk = remoteMemory();
    const learning = new LearningService(pool, { confirmed, risk }, 250);
    const a = await transferCase(531, learning);
    expect(a.trace.modelCalls).toBe(3);
    expect((await learning.pubs(a.id)).map((job) => job.pack)).toEqual(['risk', 'risk']);
    const approval = { verdict: 'fraud_confirmed' } as const;
    const api = await startApi(service(), learning);
    const route = '/api/cases/' + a.id + '/feedback';
    const responses = await Promise.all([api.post(approval, route), api.post(approval, route)]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const [first, duplicate] = await Promise.all(responses.map((response) => response.json()));
    expect(duplicate.id).toBe(first.id);
    await drainJobs(learning);
    expect((await learning.pubs(a.id)).find((job) => job.id === first.id)).toMatchObject({ state: 'published' });
    expect(confirmed.write).toHaveBeenCalledTimes(1);
    expect(risk.write).toHaveBeenCalledTimes(2);
    expect(confirmed.stored[0]?.text).toContain('analyst_confirmed');
    expect(risk.stored.every((row) => row.text.includes('provisional'))).toBe(true);

    const restarted = new LearningService(pool, { confirmed, risk }, 250);
    const b = await transferCase(532, restarted);
    expect(b.trace.reuse).toMatchObject({
      originCase: a.id, originAgent: LOGIN_AGENT, retrievingAgent: TRANSFER_AGENT, memoryId: confirmed.stored[0]?.id,
    });
    expect(b.trace.modelCalls).toBe(2);
    expect(b.action).toBe('STEP_UP_VERIFICATION');
    confirmed.search.mockResolvedValueOnce({ records: [], matches: [] });
    const memoryMiss = await transferCase(540, restarted);
    expect(memoryMiss.trace.reuse).toBeNull();
    expect(memoryMiss.trace.modelCalls).toBe(3);
    const c = await transferCase(533, restarted, true);
    expect(c.trace.reuse?.publicationId).toBe(first.id);
    const correction = await restarted.feedback(c.id, { verdict: 'legitimate_correction', require: 'recent_reset', publicationId: first.id });
    expect(correction.document.version).toBe(2);
    await drainJobs(restarted);
    const d = await transferCase(534, restarted, true);
    expect(d.trace.reuse).toBeNull();
    expect(d.trace.rejectedMemories).toEqual(expect.arrayContaining([
      { memoryId: confirmed.stored[0]?.id, reason: 'superseded' },
      { memoryId: confirmed.stored[1]?.id, reason: 'conditions_not_met' },
    ]));
    expect(d.action).toBe('STEP_UP_VERIFICATION');
    await pool.query("UPDATE memory_publications SET verified_at = clock_timestamp() - interval '31 days' WHERE id = $1", [correction.id]);
    const later = await transferCase(535, restarted);
    expect(later.trace.reuse).toBeNull();
    expect(later.trace.rejectedMemories).toEqual(expect.arrayContaining([
      { memoryId: confirmed.stored[1]?.id, reason: 'stale' },
    ]));
  });

  it('discovers confirmed context by ordinary evidence-ranked search in the extended profile', async () => {
    const confirmed = remoteMemory();
    const learning = new LearningService(pool, { confirmed }, 250);
    const original = await transferCase(541, learning);
    const publication = await learning.feedback(original.id, { verdict: 'fraud_confirmed' });
    await drainJobs(learning);
    const active = confirmed.stored[0]!;
    const otherRun = { id: randomUUID(), text: active.text };
    // A high-ranked copy whose remote identity is outside this registry is ineligible.
    confirmed.stored.unshift(otherRun);
    const investigate = service({ mode: 'meko', advanced: true, collective: true, learning, model: collectiveModel });
    async function newerTransfer(seed: number) {
      const events = generateScenario(seed, 'takeover').events.map((event) => ({
        ...event, timestamp: new Date(Date.parse(event.timestamp) + 86_400_000).toISOString(),
      }));
      for (const event of events.slice(0, -1)) await service().ingest(event);
      return (await investigate.ingest(events.at(-1)!)).case;
    }
    const found = await newerTransfer(542);
    expect(found.trace.context).toMatchObject({ status: 'ok', lookup: 'search' });
    expect(found.trace.reuse).toMatchObject({ memoryId: active.id, publicationId: publication.id });
    expect(found.trace.rejectedMemories).toContainEqual({ memoryId: otherRun.id, reason: 'unverified' });
    expect(confirmed.read).toHaveBeenCalledTimes(1); // Publication verification only.
    const topic = confirmed.search.mock.calls.at(-1)?.[0];
    expect(topic).toContain('recent password reset');
    expect(topic).toContain('amount above historical baseline');
    expect(topic).not.toContain(active.id);

    const api = await startApi(investigate, learning);
    const route = '/api/memory-publications/' + publication.id + '/revoke';
    const revocation = { reason: 'incorrect_generalization' };
    const revoked = await api.post(revocation, route);
    expect(revoked.status).toBe(200);
    const firstAt = (await revoked.json()).revoked_at;
    expect(new Date(firstAt).getTime()).toBeGreaterThan(0);
    const duplicate = await api.post(revocation, route);
    expect((await duplicate.json()).revoked_at).toBe(firstAt);
    expect((await api.post({ reason: 'invalid_confirmation' }, route)).status).toBe(409);

    const retired = await newerTransfer(543);
    expect(retired.trace.reuse).toBeNull();
    expect(retired.trace.rejectedMemories).toContainEqual({ memoryId: active.id, reason: 'revoked' });
    expect(retired.action).toBe(found.action);

    confirmed.stored.length = 0;
    const missed = await newerTransfer(544);
    expect(missed.trace.reuse).toBeNull();
    expect(missed.trace.team?.some((role) => role.agentId === LOGIN_AGENT)).toBe(true);
    expect(missed.action).toBe(found.action);
  });

  it('reconciles a lost acknowledgement and delayed indexing without a second write', async () => {
    const remote = remoteMemory();
    remote.write.mockImplementationOnce(async (text) => {
      remote.stored.push({ id: randomUUID(), text });
      throw new DependencyError('meko_transport_error');
    });
    const learning = new LearningService(pool, { confirmed: remote }, 250);
    const a = await transferCase(536, learning);
    const queued = await learning.feedback(a.id, { verdict: 'fraud_confirmed' });
    expect(await learning.workOne()).toMatchObject({ id: queued.id, state: 'uncertain', attempts: 1 });
    remote.search.mockResolvedValue({ records: [], matches: [] });
    remote.recent.mockResolvedValueOnce([]);
    await makeJobsDue();
    expect(await learning.workOne()).toMatchObject({ id: queued.id, state: 'uncertain', attempts: 2 });
    await makeJobsDue();
    expect(await learning.workOne()).toMatchObject({ id: queued.id, state: 'published', remote_id: remote.stored[0]?.id, last_operation: 'recent_inventory' });
    expect(remote.write).toHaveBeenCalledTimes(1);
  });

  it('recovers pending work across restarts and verifies acknowledged writes by ID after delayed visibility', async () => {
    const confirmed = remoteMemory();
    confirmed.search.mockResolvedValue({ records: [], matches: [] });
    const beforeRestart = new LearningService(pool, { confirmed }, 250);
    const a = await transferCase(621, beforeRestart);
    const queued = await beforeRestart.feedback(a.id, { verdict: 'fraud_confirmed' });

    const sender = new LearningService(pool, { confirmed }, 250);
    const sent = await sender.workOne(queued.id);
    expect(sent).toMatchObject({ state: 'indexing', last_operation: 'write' });
    expect(sent?.write_acknowledged_at).toBeInstanceOf(Date);
    const resumed = new LearningService(pool, { confirmed }, 250);
    await makeJobsDue();
    confirmed.read.mockResolvedValueOnce(null);
    expect(await resumed.workOne(queued.id)).toMatchObject({
      state: 'indexing', last_operation: 'exact_id', last_error: 'not_visible',
    });
    await makeJobsDue();
    expect(await resumed.workOne(queued.id)).toMatchObject({
      state: 'published', last_operation: 'exact_id', remote_id: sent?.remote_id,
    });
    expect(await resumed.workOne(queued.id)).toBeNull();
    expect(confirmed.write).toHaveBeenCalledTimes(1);
    expect(confirmed.search.mock.calls.filter(([query]) => query.includes(queued.id))).toHaveLength(0);
  });

  it('keeps same-seed demo runs isolated on shared hosted memory even if search omits the current run', async () => {
    const confirmed = remoteMemory();
    const learning = new LearningService(pool, { confirmed }, 250, true);
    const a = await transferCase(631, learning);
    const publication = await learning.feedback(a.id, { verdict: 'fraud_confirmed' });
    await drainJobs(learning);
    confirmed.search.mockResolvedValue({ records: [], matches: [] });
    const b = await transferCase(632, learning);
    expect(b.trace.reuse?.publicationId).toBe(publication.id);
    expect(b.trace.context).toMatchObject({ lookup: 'exact_id' });

    const repeatSchema = schema + '_repeat';
    await admin.query('CREATE SCHEMA ' + repeatSchema);
    const repeatPool = createPool(connection, '-c search_path=' + repeatSchema);
    try {
      await migrate(repeatPool);
      const isolated = new LearningService(repeatPool, { confirmed }, 250, true);
      const baseline = new CaseService(repeatPool, policy, { mode: 'rules', memoryTimeoutMs: 250, modelTimeoutMs: 250 });
      const team = new CaseService(repeatPool, policy, {
        mode: 'meko', collective: true, learning: isolated, model: collectiveModel, memoryTimeoutMs: 250, modelTimeoutMs: 250,
      });
      const sameA = await replay(631, 'takeover', baseline);
      const next = (await team.ingest(sameA)).case;
      expect(next.id).toBe(a.id);
      expect(next.trace.reuse).toBeNull();
      expect(next.trace.context).toMatchObject({ matches: [], lookup: 'exact_id' });
      const own = await isolated.feedback(next.id, { verdict: 'fraud_confirmed' });
      expect(own.id).not.toBe(publication.id);
      await isolated.workOne(own.id);
      await repeatPool.query("UPDATE memory_publications SET next_check_at = clock_timestamp() - interval '5 seconds'");
      await isolated.workOne(own.id);
      const found = await isolated.recall('confirmed', 'same query', TRANSFER_AGENT);
      expect(found?.matches).toEqual([{ id: confirmed.stored[1]?.id, score: null }]);
    } finally {
      await repeatPool.end();
      await admin.query('DROP SCHEMA ' + repeatSchema + ' CASCADE');
    }
  });


  it('keeps an acknowledged row in indexing and defers other jobs after a rate limit', async () => {
    const confirmed = remoteMemory();
    const learning = new LearningService(pool, { confirmed }, 250);
    const a = await transferCase(641, learning);
    const b = await transferCase(642, learning);
    const first = await learning.feedback(a.id, { verdict: 'fraud_confirmed' });
    const second = await learning.feedback(b.id, { verdict: 'fraud_confirmed' });
    await learning.workOne(first.id);
    await makeJobsDue();
    confirmed.read.mockRejectedValueOnce(new MekoRateLimit(30_000));
    const waiting = await learning.workOne(first.id);
    expect(waiting).toMatchObject({ state: 'indexing', last_error: 'meko_http_429' });
    const restarted = new LearningService(pool, { confirmed }, 250);
    expect(await restarted.workOne(second.id)).toBeNull();
    expect((await restarted.pubs(b.id))[0]?.next_check_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(confirmed.write).toHaveBeenCalledTimes(1);
  });


  it('records a definitive pre-submit rejection separately from an acknowledged write', async () => {
    const confirmed = remoteMemory();
    confirmed.write.mockRejectedValueOnce(new MekoWriteNotSent('meko_http_403'));
    const learning = new LearningService(pool, { confirmed }, 250);
    const a = await transferCase(645, learning);
    const queued = await learning.feedback(a.id, { verdict: 'fraud_confirmed' });
    expect(await learning.workOne(queued.id)).toMatchObject({
      state: 'failed', last_operation: 'write', last_error: 'meko_http_403', write_acknowledged_at: null,
    });
    await makeJobsDue();
    expect(await learning.workOne(queued.id)).toBeNull();
    expect(confirmed.write).toHaveBeenCalledTimes(1);
    expect(confirmed.read).not.toHaveBeenCalled();
  });

});
