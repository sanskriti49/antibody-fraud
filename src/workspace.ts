import express from 'express';
import type pg from 'pg';
import { z } from 'zod';

/** Read-only routes for the analyst workspace. Writes stay on the existing feedback and revoke routes. */
export type WorkspaceInfo = {
  mode: string;
  profile: string;
  memoryPolicy: string;
  memoryStore: 'meko' | 'local' | 'none';
  feedbackEnabled: boolean;
};

const summaryColumns = `
  c.id, c.status, c.action, c.created_at AS "createdAt", c.decided_at AS "decidedAt",
  -- Full microsecond precision as ISO text, so cursors never skip or repeat rows.
  to_json(COALESCE(c.decided_at, c.created_at))#>>'{}' AS "sortTime",
  e.kind, e.account_id AS "accountId", e.occurred_at AS "occurredAt", e.payload->>'sessionId' AS "sessionId",
  e.amount_minor AS "amountMinor", e.payee_id AS "payeeId",
  (c.trace->'risk'->>'score')::numeric AS score, c.trace->>'path' AS path,
  COALESCE((c.trace->>'modelCalls')::int, 0) AS "modelCalls",
  ARRAY(SELECT item->>'id' FROM jsonb_array_elements(c.trace->'risk'->'evidence') item) AS rules,
  c.trace->'memoryPolicy'->'match' AS "memoryMatch",
  COALESCE((c.trace->'memoryPolicy'->>'applied')::boolean, false) AS "memoryApplied",
  ARRAY(SELECT item->>'id' FROM jsonb_array_elements(COALESCE(c.trace->'playbooks', '[]'::jsonb)) item) AS playbooks,
  EXISTS (SELECT 1 FROM analyst_feedback f WHERE f.case_id = c.id) AS reviewed
`;
const views = {
  all: 'true',
  alerts: "c.action IN ('STEP_UP_VERIFICATION', 'BLOCK')",
  review: "c.action = 'STEP_UP_VERIFICATION' AND NOT EXISTS (SELECT 1 FROM analyst_feedback f WHERE f.case_id = c.id)",
  blocked: "c.action = 'BLOCK'",
  memory: "c.trace->'memoryPolicy'->'match' IS NOT NULL AND c.trace->'memoryPolicy'->'match' <> 'null'::jsonb",
  pending: "c.status = 'pending'",
} as const;
const listQuery = z.object({
  view: z.enum(Object.keys(views) as [keyof typeof views, ...(keyof typeof views)[]]).default('alerts'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
  beforeId: z.uuid().optional(),
  account: z.string().regex(/^acct-[a-z0-9-]{1,60}$/).optional(),
});

export function createWorkspaceRouter(pool: pg.Pool, info: WorkspaceInfo, pollMs = 1000) {
  const router = express.Router();

  router.get('/overview', async (_req, res) => {
    const [counts, memory, publications, playbooks] = await Promise.all([
      pool.query(`
        SELECT count(*)::int AS events,
          count(*) FILTER (WHERE c.status = 'pending')::int AS pending,
          count(*) FILTER (WHERE c.action = 'ALLOW')::int AS allowed,
          count(*) FILTER (WHERE c.action = 'STEP_UP_VERIFICATION')::int AS "stepUps",
          count(*) FILTER (WHERE c.action = 'BLOCK')::int AS blocks,
          count(*) FILTER (WHERE (c.trace->'memoryPolicy'->>'applied')::boolean)::int AS "memoryBlocks",
          COALESCE(sum((c.trace->>'modelCalls')::int), 0)::int AS "modelCalls",
          (SELECT count(*)::int FROM analyst_feedback) AS reviews
        FROM cases c`),
      pool.query(`
        SELECT count(*) FILTER (WHERE state = 'published' AND superseded_at IS NULL AND revoked_at IS NULL AND document ? 'steps')::int AS "activePatterns",
          count(*) FILTER (WHERE document ? 'steps')::int AS "patternVersions"
        FROM memory_publications WHERE pack = 'confirmed'`),
      pool.query(`SELECT pack, state, count(*)::int AS count FROM memory_publications GROUP BY pack, state ORDER BY pack, state`),
      pool.query(`SELECT count(DISTINCT id)::int AS count FROM playbooks`),
    ]);
    res.json({ config: info, counts: counts.rows[0], memory: { ...memory.rows[0], publications: publications.rows }, playbooks: playbooks.rows[0]?.count ?? 0 });
  });

  router.get('/cases', async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'invalid_case_query' });
      return;
    }
    const { view, limit, before, beforeId, account } = query.data;
    const rows = await pool.query(`
      SELECT ${summaryColumns} FROM cases c JOIN events e ON e.id = c.id
      WHERE ${views[view]}
        AND ($1::timestamptz IS NULL OR (COALESCE(c.decided_at, c.created_at), c.id) < ($1::timestamptz, COALESCE($4::uuid, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
        AND ($3::text IS NULL OR e.account_id = $3)
      ORDER BY COALESCE(c.decided_at, c.created_at) DESC, c.id DESC LIMIT $2
    `, [before ?? null, limit, account ?? null, beforeId ?? null]);
    res.json({ view, items: rows.rows });
  });

  router.get('/cases/:id/context', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: 'invalid_case_id' });
      return;
    }
    const target = (await pool.query<{ account_id: string; occurred_at: Date; session_id: string | null }>(
      "SELECT account_id, occurred_at, payload->>'sessionId' AS session_id FROM events WHERE id = $1", [id.data])).rows[0];
    if (!target) {
      res.status(404).json({ error: 'case_not_found' });
      return;
    }
    // The session around this event: same account and session ID, or the account's nearby activity.
    const [session, feedback, publications] = await Promise.all([
      pool.query(`
        SELECT ${summaryColumns} FROM cases c JOIN events e ON e.id = c.id
        WHERE e.account_id = $1 AND e.occurred_at BETWEEN $2::timestamptz - interval '30 minutes' AND $2::timestamptz + interval '30 minutes'
          AND ($3::text IS NULL OR e.payload->>'sessionId' = $3)
        ORDER BY e.occurred_at, e.id LIMIT 40
      `, [target.account_id, target.occurred_at, target.session_id]),
      pool.query('SELECT request, publication_id AS "publicationId", created_at AS "createdAt" FROM analyst_feedback WHERE case_id = $1', [id.data]),
      pool.query(`
        SELECT id, pack, kind, state, attempts, remote_id AS "remoteId", verified_at AS "verifiedAt", superseded_at AS "supersededAt",
          revoked_at AS "revokedAt", last_error AS "lastError", document->>'version' AS version
        FROM memory_publications WHERE case_id = $1 ORDER BY kind, id`, [id.data]),
    ]);
    res.json({ session: session.rows, feedback: feedback.rows[0] ?? null, publications: publications.rows });
  });

  router.get('/memory/patterns', async (_req, res) => {
    const rows = await pool.query(`
      SELECT m.id, m.state, m.remote_id AS "remoteId", m.verified_at AS "verifiedAt", m.superseded_at AS "supersededAt",
        m.revoked_at AS "revokedAt", m.revocation_reason AS "revocationReason", m.last_error AS "lastError",
        m.document->>'pattern' AS pattern, (m.document->>'version')::int AS version, m.document->>'originCase' AS "originCase",
        m.document->>'feedbackCase' AS "feedbackCase", m.document->>'supersedes' AS supersedes, m.document->>'originAgent' AS "originAgent",
        m.document->'steps' AS steps, COALESCE(m.document->'conditions', '[]'::jsonb) AS conditions,
        m.document->'required' AS required, m.document->'evidence' AS evidence,
        (SELECT count(*)::int FROM analyst_feedback f WHERE f.publication_id = m.id) AS confirmations,
        (SELECT count(*)::int FROM cases c WHERE c.trace->'memoryPolicy'->'match'->>'publicationId' = m.id::text) AS matches,
        (SELECT count(*)::int FROM cases c WHERE c.trace->'memoryPolicy'->'match'->>'publicationId' = m.id::text
          AND (c.trace->'memoryPolicy'->>'applied')::boolean) AS "actionsChanged",
        source.account_id AS "originAccount"
      FROM memory_publications m LEFT JOIN events source ON source.id::text = m.document->>'originCase'
      WHERE m.pack = 'confirmed' AND m.kind = 'fingerprint'
      ORDER BY (m.superseded_at IS NULL AND m.revoked_at IS NULL) DESC, m.verified_at DESC NULLS FIRST, m.id
    `);
    res.json({ items: rows.rows });
  });

  router.get('/playbooks', async (_req, res) => {
    const rows = await pool.query(`
      SELECT DISTINCT ON (p.id) p.id, p.version, p.title, p.checksum, p.body, p.triggers, p.checklist, p.loaded_at AS "loadedAt",
        p.kb_state AS "knowledgeBase", p.kb_checked_at AS "checkedAt", p.kb_error AS "error",
        (SELECT count(*)::int FROM cases c WHERE c.trace->'playbooks' @> jsonb_build_array(jsonb_build_object('id', p.id))) AS cases
      FROM playbooks p ORDER BY p.id, p.version DESC
    `);
    res.json({ items: rows.rows });
  });

  // Server-sent events: newly decided cases, polled from PostgreSQL so events from any process appear.
  router.get('/stream', async (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const start = (await pool.query<{ t: string; id: string }>(`
      SELECT to_json(decided_at)#>>'{}' AS t, id FROM cases WHERE status = 'decided' ORDER BY decided_at DESC, id DESC LIMIT 1
    `)).rows[0];
    let cursor = { t: start?.t ?? '1970-01-01T00:00:00Z', id: start?.id ?? '00000000-0000-0000-0000-000000000000' };
    let closed = false;
    let busy = false;
    res.write('event: hello\ndata: ' + JSON.stringify({ cursor }) + '\n\n');
    const tick = setInterval(async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const rows = (await pool.query(`
          SELECT ${summaryColumns} FROM cases c JOIN events e ON e.id = c.id
          WHERE c.status = 'decided' AND (c.decided_at, c.id) > ($1::timestamptz, $2::uuid) ORDER BY c.decided_at, c.id LIMIT 200
        `, [cursor.t, cursor.id])).rows;
        if (rows.length) {
          const last = rows.at(-1)!;
          cursor = { t: last.sortTime, id: last.id };
          res.write('event: cases\ndata: ' + JSON.stringify(rows) + '\n\n');
        }
      } catch {
        res.write('event: degraded\ndata: {}\n\n');
      } finally {
        busy = false;
      }
    }, pollMs);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      closed = true;
      clearInterval(tick);
      clearInterval(heartbeat);
    });
  });

  return router;
}
