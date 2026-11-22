import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { CaseService, DuplicateEventConflict } from './cases.js';
import { FeedbackError, feedbackSchema, fingerprintRevocationSchema, type LearningService } from './learning.js';
import { eventSchema } from './events.js';
import { createWorkspaceRouter, type WorkspaceInfo } from './workspace.js';

const webBuild = fileURLToPath(new URL('../web/dist/', import.meta.url));

export function createApp(pool: pg.Pool, cases: CaseService, learning?: LearningService, workspace?: WorkspaceInfo) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1 FROM cases LIMIT 1');
      res.json({ status: 'ok', database: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unready' });
    }
  });

  app.post('/api/events', async (req, res) => {
    const event = eventSchema.safeParse(req.body);
    if (!event.success) {
      res.status(400).json({
        error: 'invalid_event', fields: event.error.issues.map((issue) => issue.path.join('.')),
      });
      return;
    }
    const result = await cases.ingest(event.data);
    res.location('/api/cases/' + event.data.id);
    res.status(result.case.status === 'pending' ? 202 : result.duplicate ? 200 : 201).json(result);
  });

  app.get('/api/cases/:id', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: 'invalid_case_id' });
      return;
    }
    const row = await cases.find(id.data);
    if (!row) {
      res.status(404).json({ error: 'case_not_found' });
      return;
    }
    res.json(row);
  });

  if (learning) {
    app.post('/api/cases/:id/feedback', async (req, res) => {
      const id = z.uuid().safeParse(req.params.id);
      const feedback = feedbackSchema.safeParse(req.body);
      if (!id.success || !feedback.success) {
        res.status(400).json({ error: 'invalid_feedback' });
        return;
      }
      const publication = await learning.feedback(id.data, feedback.data);
      res.status(202).json(publication);
    });
    app.post('/api/memory-publications/:id/revoke', async (req, res) => {
      const id = z.uuid().safeParse(req.params.id);
      const request = fingerprintRevocationSchema.safeParse(req.body);
      if (!id.success || !request.success) {
        res.status(400).json({ error: 'invalid_fingerprint_revocation' });
        return;
      }
      res.json(await learning.revokeFingerprint(id.data, request.data.reason));
    });
    app.get('/api/cases/:id/publications', async (req, res) => {
      const id = z.uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ error: 'invalid_case_id' });
        return;
      }
      res.json(await learning.pubs(id.data));
    });
  }

  if (workspace) {
    app.use('/api', createWorkspaceRouter(pool, workspace));
    // The built React workspace, when present. API routes above take precedence.
    if (existsSync(webBuild)) {
      app.use(express.static(webBuild, { index: 'index.html' }));
      app.get(/^\/(?!api\/|health$).*/, (_req, res) => res.sendFile('index.html', { root: webBuild }));
    }
  }

  const onError: express.ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof DuplicateEventConflict) {
      res.status(409).json({ error: 'event_id_conflict' });
    } else if (error instanceof FeedbackError) {
      res.status(error.code === 'confirmed_pack_unconfigured' ? 503 : 409).json({ error: error.code });
    } else if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid_json_body' });
    } else {
      const code = typeof error?.code === 'string' && /^[0-9A-Z]{2,20}$/.test(error.code) ? error.code : 'internal';
      console.error('Request failed (' + code + ')');
      res.status(500).json({ error: 'internal_error' });
    }
  };
  app.use(onError);
  return app;
}
