import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CaseService } from '../src/cases.js';
import { createPool, migrate } from '../src/database.js';
import { generateEarlyCorpus } from '../src/early-scenarios.js';
import { localMemoryGateway } from '../src/integrations/local-memory.js';
import { LearningService } from '../src/learning.js';
import { loadPlaybooks } from '../src/playbooks.js';

const endpoint = process.env.TEST_DATABASE_URL;
if (!endpoint) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = 'contextcon_workspace_test_' + randomUUID().replaceAll('-', '');
let admin: pg.Pool;
let pool: pg.Pool;
let server: Server;
let base: string;

beforeAll(async () => {
  admin = createPool(endpoint);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(endpoint, '-c search_path=' + schema);
  await migrate(pool);
  await loadPlaybooks(pool);
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server ? server.close(resolve) : resolve(undefined));
  await pool?.end();
  if (admin) {
    try {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      await admin.end();
    }
  }
});

it('serves overview, filtered case lists, session context, patterns, playbooks and a live stream', async () => {
  const learning = new LearningService(pool, { confirmed: localMemoryGateway() }, 250);
  const cases = new CaseService(pool, { challenge: 25, block: 72 }, {
    mode: 'rules', advanced: true, memoryTimeoutMs: 250, modelTimeoutMs: 250, memoryPolicy: 'enforce',
  });
  server = createApp(pool, cases, learning, {
    mode: 'rules', profile: 'extended', memoryPolicy: 'enforce', memoryStore: 'local', feedbackEnabled: true,
  }, ).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  base = 'http://127.0.0.1:' + address.port;
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;

  const corpus = generateEarlyCorpus({ split: 'evaluation', seed: 7403, maxEvents: 60, scenario: 'takeover' });
  const [first, ...rest] = corpus.episodes;
  const of = (id: string) => corpus.events.filter((event) => corpus.labels.get(event.id)?.episodeId === id);
  for (const event of of(first!.id)) await cases.ingest(event);
  const confirmed = await (await fetch(base + '/api/cases/' + first!.impactId + '/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: 'fraud_confirmed' }),
  })).json() as any;
  for (let attempt = 0; attempt < 4; attempt++) {
    await pool.query('UPDATE memory_publications SET next_check_at = clock_timestamp()');
    await learning.workOne();
  }

  const stream = await fetch(base + '/api/stream');
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  const read = (async () => {
    while (!received.includes('event: cases')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const event of of(rest[0]!.id)) await cases.ingest(event);
  await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 4000))]);
  await reader.cancel();
  expect(received).toContain('event: hello');
  expect(received).toContain('event: cases');

  const overview = await get('/api/overview');
  expect(overview).toMatchObject({ config: { memoryStore: 'local', feedbackEnabled: true }, playbooks: 6, memory: { activePatterns: 1 } });
  expect(overview.counts.memoryBlocks).toBeGreaterThan(0);

  const blocked = await get('/api/cases?view=blocked');
  expect(blocked.items.length).toBe(overview.counts.blocks);
  expect(blocked.items[0]).toMatchObject({ action: 'BLOCK', memoryApplied: true, rules: expect.arrayContaining(['verified_pattern_match']) });
  const memory = await get('/api/cases?view=memory&limit=1');
  const page = await get('/api/cases?view=memory&limit=50&before=' + encodeURIComponent(memory.items[0].sortTime) + '&beforeId=' + memory.items[0].id);
  expect(page.items.map((item: any) => item.id)).not.toContain(memory.items[0].id);
  expect((await fetch(base + '/api/cases?view=nope')).status).toBe(400);

  const context = await get('/api/cases/' + first!.impactId + '/context');
  expect(context.session.map((row: any) => row.kind)).toEqual(['login', 'password_reset', 'payee_added', 'transfer']);
  expect(context.feedback).toMatchObject({ publicationId: confirmed.id });
  expect(context.publications[0]).toMatchObject({ pack: 'confirmed', state: 'published' });

  const patterns = await get('/api/memory/patterns');
  expect(patterns.items[0]).toMatchObject({ id: confirmed.id, pattern: 'session_sequence', confirmations: 1, originAccount: of(first!.id)[0]!.accountId });
  expect(patterns.items[0].actionsChanged).toBeGreaterThan(0);
  const playbooks = await get('/api/playbooks');
  expect(playbooks.items.find((item: any) => item.id === 'pb-verified-pattern-review').cases).toBeGreaterThan(0);
});
