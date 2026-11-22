import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DependencyError } from './ports.js';

/**
 * Meko knowledge-base upload over the documented Datapack REST contract:
 * POST upload-url, POST the bytes as multipart form data to storage, then poll document-status.
 * Storage never receives the API key. https://docs.mekodata.ai/reference/datapack-api/
 */
const base = 'https://api.mekodata.ai/api/v1';
const userAgent = 'contextcon-fraud-lab/0.1';
export const terminalStates = ['completed', 'failed', 'abandoned', 'oversized'] as const;
export const documentStates = ['awaiting_upload', 'indexing', ...terminalStates] as const;
export type DocumentState = typeof documentStates[number];

const uploadSchema = z.looseObject({
  data: z.looseObject({
    url: z.string(),
    key: z.string().min(1),
    already_uploaded: z.boolean(),
    status_url: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
const statusSchema = z.looseObject({
  data: z.looseObject({ document_key: z.string(), state: z.enum(documentStates), message: z.string().nullish() }),
});

export class KnowledgeError extends DependencyError {}

type Fetch = typeof fetch;

export function mekoKnowledgeBase(key: string, datapackId: string, fetcher: Fetch = fetch) {
  const headers = { Authorization: 'Bearer ' + key, 'User-Agent': userAgent };
  async function api(path: string, init: RequestInit, signal: AbortSignal) {
    const response = await fetcher(base + path, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new KnowledgeError('meko_kb_http_' + response.status);
    }
    return response.json() as Promise<unknown>;
  }

  return {
    /** Upload one UTF-8 file. Returns the document key and whether Meko already had these bytes. */
    async upload(filename: string, text: string, signal: AbortSignal) {
      const bytes = Buffer.from(text, 'utf8');
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      const reply = uploadSchema.safeParse(await api('/datapacks/' + datapackId + '/knowledge-bases/upload-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, size: bytes.length, content_hash: contentHash, client: userAgent }),
      }, signal));
      if (!reply.success) throw new KnowledgeError('meko_kb_unrecognized_upload_reply');
      const { url, key: documentKey, already_uploaded: alreadyUploaded, fields } = reply.data.data;
      if (!alreadyUploaded) {
        if (!/^https:\/\//.test(url) || !fields) throw new KnowledgeError('meko_kb_unrecognized_upload_reply');
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) form.append(name, value);
        form.append('file', new Blob([bytes], { type: 'text/markdown' }), filename);
        // Presigned storage URL: no Authorization header.
        const stored = await fetcher(url, { method: 'POST', body: form, redirect: 'error', signal });
        await stored.body?.cancel();
        if (!stored.ok) throw new KnowledgeError('meko_kb_storage_' + stored.status);
      }
      return { documentKey, alreadyUploaded, contentHash };
    },

    async status(documentKey: string, signal: AbortSignal) {
      const path = '/datapacks/' + datapackId + '/knowledge-bases/document-status?document_key=' + encodeURIComponent(documentKey);
      let reply: unknown;
      try {
        reply = await api(path, { method: 'GET' }, signal);
      } catch (error) {
        // A 404 can occur briefly during the storage handoff.
        if (error instanceof KnowledgeError && error.code === 'meko_kb_http_404') return { state: 'awaiting_upload' as const, message: null };
        throw error;
      }
      const parsed = statusSchema.safeParse(reply);
      if (!parsed.success) throw new KnowledgeError('meko_kb_unrecognized_status');
      return { state: parsed.data.data.state, message: parsed.data.data.message ?? null };
    },
  };
}
