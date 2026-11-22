import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';
import { mekoMemoryGateway } from '../integrations/meko.js';
import { mekoKnowledgeBase, terminalStates } from '../integrations/meko-knowledge.js';
import { INVESTIGATOR_AGENT } from '../learning.js';
import { loadPlaybooks, readPlaybookFiles } from '../playbooks.js';

const { values } = parseArgs({ options: {
  wait: { type: 'string', default: '90' },
  probe: { type: 'string' },
} });
const waitSeconds = z.coerce.number().int().min(0).max(900).parse(values.wait);
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

type Row = { id: string; version: number; checksum: string; kb_state: string; kb_document_key: string | null };

try {
  await migrate(pool);
  const loaded = await loadPlaybooks(pool);
  console.error(loaded.length ? 'Loaded ' + loaded.join(', ') : 'Registry already has every playbook version.');
  const key = config.MEKO_API_KEY;
  const datapack = config.MEKO_DATAPACK_ID;
  if (!key || !datapack) {
    console.error('No Meko key or confirmed datapack configured. Playbooks stay in the local registry only.');
  } else {
    const kb = mekoKnowledgeBase(key, datapack);
    const files = new Map((await readPlaybookFiles()).map((file) => [file.playbook.checksum, file]));
    const pending = (await pool.query<Row>(`
      SELECT DISTINCT ON (id) id, version, checksum, kb_state, kb_document_key FROM playbooks ORDER BY id, version DESC
    `)).rows.filter((row) => row.kb_state !== 'completed');
    for (const row of pending) {
      const file = files.get(row.checksum);
      if (!file) {
        console.error(row.id + ' v' + row.version + ' has no matching file. Skipped.');
        continue;
      }
      let documentKey = row.kb_document_key;
      if (!documentKey || ['failed', 'abandoned', 'oversized', 'local'].includes(row.kb_state)) {
        try {
          const uploaded = await kb.upload(row.id + '-v' + row.version + '.md', file.text, AbortSignal.timeout(config.MEKO_TIMEOUT_MS));
          documentKey = uploaded.documentKey;
          await pool.query(`UPDATE playbooks SET kb_state = 'indexing', kb_document_key = $3, kb_error = NULL,
            kb_checked_at = clock_timestamp() WHERE id = $1 AND version = $2`, [row.id, row.version, documentKey]);
          console.error(row.id + ' v' + row.version + (uploaded.alreadyUploaded ? ' already in Meko.' : ' uploaded.'));
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String(error.code) : 'meko_kb_upload_failed';
          await pool.query(`UPDATE playbooks SET kb_state = 'failed', kb_error = $3, kb_checked_at = clock_timestamp()
            WHERE id = $1 AND version = $2`, [row.id, row.version, code]);
          console.error(row.id + ' v' + row.version + ' upload failed: ' + code);
          continue;
        }
      }
    }
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const open = (await pool.query<Row>(`SELECT id, version, checksum, kb_state, kb_document_key FROM playbooks
        WHERE kb_document_key IS NOT NULL AND kb_state IN ('awaiting_upload', 'indexing')`)).rows;
      if (!open.length || Date.now() > deadline) break;
      for (const row of open) {
        try {
          const status = await kb.status(row.kb_document_key!, AbortSignal.timeout(config.MEKO_TIMEOUT_MS));
          await pool.query(`UPDATE playbooks SET kb_state = $3, kb_error = $4, kb_checked_at = clock_timestamp()
            WHERE id = $1 AND version = $2`, [row.id, row.version, status.state,
            (terminalStates as readonly string[]).includes(status.state) && status.state !== 'completed' ? status.message ?? status.state : null]);
        } catch {
          // Keep polling until the deadline. The next run resumes from the stored key.
        }
      }
      await pause(3000);
    }
    if (values.probe) {
      const result = await mekoMemoryGateway(key, datapack).knowledgeSearch(values.probe, INVESTIGATOR_AGENT, AbortSignal.timeout(config.MEKO_TIMEOUT_MS));
      console.error('knowledgebase_search fields:', result.fields.join(', ') || '(none)', '| hit fields:', result.hitFields.join(', ') || '(none)');
      console.table(result.hits.map((hit) => ({ documentId: hit.documentId, score: hit.score, text: hit.text?.slice(0, 80) })));
    }
  }
  const rows = (await pool.query(`SELECT id, version, title, kb_state AS "knowledgeBase", kb_error AS error FROM playbooks ORDER BY id, version`)).rows;
  console.table(rows);
} catch (error) {
  console.error('Playbook sync failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
} finally {
  await pool.end();
}
