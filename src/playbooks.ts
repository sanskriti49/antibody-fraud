import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type pg from 'pg';
import { z } from 'zod';

/**
 * Approved fraud playbooks. Markdown files with a small front-matter header are the source of
 * truth. Selection for a case is deterministic: a playbook applies when every rule in one of its
 * triggers fired somewhere in the session. Playbooks are read-only context. They never change an
 * action, and models see only their titles and checklist items.
 */
const rule = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const headerSchema = z.strictObject({
  id: z.string().regex(/^pb-[a-z0-9-]{1,60}$/),
  version: z.coerce.number().int().positive(),
  title: z.string().min(1).max(120),
  status: z.literal('approved'),
  triggers: z.array(z.array(rule).min(1).max(6)).min(1).max(8),
});
export type Playbook = z.infer<typeof headerSchema> & { checksum: string; body: string; checklist: string[] };
export type PlaybookReference = {
  id: string; version: number; title: string; checksum: string; matchedTrigger: string[];
  knowledgeBase: string; checklist: string[];
};

export const playbookDirectory = new URL('../playbooks/', import.meta.url);

export function parsePlaybook(text: string): Playbook {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) throw new Error('Playbook needs a front-matter header');
  const header: Record<string, unknown> = { triggers: [] };
  for (const line of match[1]!.split('\n')) {
    const pair = /^([a-z]+):\s*(.+)$/.exec(line.trim());
    if (!pair) continue;
    if (pair[1] === 'trigger') (header.triggers as string[][]).push(pair[2]!.split(',').map((item) => item.trim()));
    else header[pair[1]!] = pair[2]!.trim();
  }
  const parsed = headerSchema.parse(header);
  const body = match[2]!.trim() + '\n';
  const section = /## Investigation checklist\n([\s\S]*?)(?:\n## |\n?$)/.exec(body)?.[1] ?? '';
  const checklist = section.split('\n').flatMap((line) => /^- (.+)$/.exec(line.trim())?.[1] ?? []).slice(0, 6);
  return { ...parsed, body, checklist, checksum: createHash('sha256').update(text).digest('hex') };
}

export async function readPlaybookFiles(directory = playbookDirectory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
  return Promise.all(names.map(async (name) => {
    const text = await readFile(new URL(name, directory), 'utf8');
    return { name, text, playbook: parsePlaybook(text) };
  }));
}

/** Insert new versions. A changed file must carry a new version number. */
export async function loadPlaybooks(pool: Pick<pg.Pool, 'query'>, directory = playbookDirectory) {
  const files = await readPlaybookFiles(directory);
  const loaded: string[] = [];
  for (const { playbook } of files) {
    const existing = (await pool.query<{ checksum: string }>(
      'SELECT checksum FROM playbooks WHERE id = $1 AND version = $2', [playbook.id, playbook.version])).rows[0];
    if (existing) {
      if (existing.checksum !== playbook.checksum) {
        throw new Error('Playbook ' + playbook.id + ' v' + playbook.version + ' changed. Increase its version.');
      }
      continue;
    }
    await pool.query(`
      INSERT INTO playbooks (id, version, title, checksum, body, triggers, checklist)
      VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING
    `, [playbook.id, playbook.version, playbook.title, playbook.checksum, playbook.body,
      JSON.stringify(playbook.triggers), JSON.stringify(playbook.checklist)]);
    loaded.push(playbook.id + ' v' + playbook.version);
  }
  return loaded;
}

type PlaybookRow = {
  id: string; version: number; title: string; checksum: string; triggers: string[][]; checklist: string[]; kb_state: string;
};

/** Latest version of each approved playbook whose trigger is fully present in the session. */
export async function selectPlaybooks(db: Pick<pg.PoolClient, 'query'>, sessionRules: readonly string[]): Promise<PlaybookReference[]> {
  if (!sessionRules.length) return [];
  const rows = (await db.query<PlaybookRow>(`
    SELECT DISTINCT ON (id) id, version, title, checksum, triggers, checklist, kb_state
    FROM playbooks ORDER BY id, version DESC
  `)).rows;
  const present = new Set(sessionRules);
  return rows.flatMap((row) => {
    const trigger = row.triggers.find((rules) => rules.every((id) => present.has(id)));
    return trigger ? [{
      id: row.id, version: row.version, title: row.title, checksum: row.checksum, matchedTrigger: trigger,
      knowledgeBase: row.kb_state, checklist: row.checklist,
    }] : [];
  });
}

const normalize = (text: string) => text.split('\n').filter((line) => !line.trim().startsWith('#'))
  .map((line) => line.replace(/^\s*- /, '')).join('').replace(/\s+/g, '');

export type BoundPassage = { documentId: string | null; playbookId: string; version: number; title: string; section: string; excerpt: string; score: number | null };

/**
 * Bind a Meko knowledge-base chunk to an approved registry version. The chunk names its document
 * title, and its section text must appear verbatim (ignoring whitespace and list markers) in that
 * approved body. Anything else is counted as unverified and never reaches a model.
 */
export async function bindKnowledgeHits(db: Pick<pg.PoolClient, 'query'>, hits: readonly { documentId: string | null; text: string | null; score: number | null }[]) {
  const rows = (await db.query<{ id: string; version: number; title: string; body: string }>(
    'SELECT DISTINCT ON (id) id, version, title, body FROM playbooks ORDER BY id, version DESC')).rows;
  const bound: BoundPassage[] = [];
  let unverified = 0;
  for (const hit of hits) {
    const match = /^Document: (.+)\nSection: (.+)\n\n([\s\S]+)$/.exec(hit.text ?? '');
    const playbook = match && rows.find((row) => row.title === match[1]!.trim());
    const content = match ? normalize(match[3]!) : '';
    if (!match || !playbook || content.length < 20 || !normalize(playbook.body).includes(content)) {
      unverified++;
      continue;
    }
    bound.push({
      documentId: hit.documentId, playbookId: playbook.id, version: playbook.version, title: playbook.title,
      section: match[2]!.split('>').at(-1)!.trim(), excerpt: match[3]!.trim().slice(0, 400), score: hit.score,
    });
  }
  return { bound, unverified };
}
