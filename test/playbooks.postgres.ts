import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CaseService } from '../src/cases.js';
import { createPool, migrate } from '../src/database.js';
import { generateEarlyCorpus } from '../src/early-scenarios.js';
import { loadPlaybooks } from '../src/playbooks.js';

const endpoint = process.env.TEST_DATABASE_URL;
if (!endpoint) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = 'contextcon_playbook_test_' + randomUUID().replaceAll('-', '');
let admin: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
  admin = createPool(endpoint);
  await admin.query('CREATE SCHEMA ' + schema);
  pool = createPool(endpoint, '-c search_path=' + schema);
  await migrate(pool);
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

it('loads versions once, refuses an edited version, and attaches matching playbooks to alerted cases', async () => {
  expect((await loadPlaybooks(pool)).length).toBeGreaterThanOrEqual(6);
  expect(await loadPlaybooks(pool)).toEqual([]);

  const directory = await mkdtemp(join(tmpdir(), 'playbooks-'));
  const original = await readFile(new URL('../playbooks/account-takeover.md', import.meta.url), 'utf8');
  await writeFile(join(directory, 'account-takeover.md'), original.replace('Typical sequence', 'Usual sequence'));
  await expect(loadPlaybooks(pool, pathToFileURL(directory + '/'))).rejects.toThrow(/Increase its version/);

  const corpus = generateEarlyCorpus({ split: 'evaluation', seed: 7403, maxEvents: 40, scenario: 'takeover' });
  const service = new CaseService(pool, { challenge: 25, block: 72 }, { mode: 'rules', advanced: true, memoryTimeoutMs: 250, modelTimeoutMs: 250 });
  const rows = [];
  for (const event of corpus.events) rows.push((await service.ingest(event)).case);
  const alerted = rows.filter((row) => row.action !== 'ALLOW');
  expect(alerted.length).toBeGreaterThan(0);
  for (const row of alerted) {
    expect(row.trace.playbooks?.map((item) => item.id)).toContain('pb-account-takeover');
    expect(row.trace.playbooks?.[0]).toMatchObject({ version: 1, knowledgeBase: 'local', checklist: expect.any(Array) });
  }
  expect(rows.filter((row) => row.action === 'ALLOW').every((row) => row.trace.playbooks === undefined)).toBe(true);
  const transfer = alerted.find((row) => row.trace.eventKind === 'transfer');
  expect(transfer?.trace.playbooks?.map((item) => item.id)).toEqual(expect.arrayContaining(['pb-account-takeover', 'pb-payee-velocity']));
});
