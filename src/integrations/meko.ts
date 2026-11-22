import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DependencyError, type MemoryReader } from './ports.js';

const endpoint = 'https://mcp.mekodata.ai/mcp';
const userAgent = 'contextcon-fraud-lab/0.1';
const agentId = 'contextcon-behaviour-login';
const payloadSchema = z.looseObject({ results: z.array(z.record(z.string(), z.unknown())) });
const memoryId = z.uuid();
const score = z.number();
const object = z.record(z.string(), z.unknown());

type Diagnostic = (event: string, fields: Record<string, unknown>) => void;
type ToolReply = {
  isError?: boolean;
  structuredContent?: unknown;
  content: { type: string; text?: string }[];
};

class MekoError extends DependencyError {
  constructor(code: string, readonly details: Record<string, string | number> = {}) {
    super(code);
  }
}

function parseTextBlock(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const providerCodes = new Set([
  'VALIDATION_ERROR', 'INVALID_PARAMS', 'INVALID_TOKEN', 'UNAUTHORIZED', 'FORBIDDEN',
  'PERMISSION_DENIED', 'READ_ONLY_ACCESS', 'NOT_FOUND', 'DATAPACK_NOT_FOUND',
  'PAT_RATE_LIMITED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'INTERNAL_ERROR',
]);

function toolError(value: unknown) {
  // Provider errors can echo the request or stored text. Report only known categories.
  const text = typeof value === 'string' ? value.slice(0, 4000) : '';
  if (/\bconversation_id\b[\s\S]{0,120}\b(?:Field required|Missing required argument|is required|required field)\b/i.test(text)) {
    return new MekoError('meko_tool_conversation_id_required', { category: 'tool', field: 'conversation_id' });
  }
  const body = object.safeParse(typeof value === 'string' ? parseTextBlock(text) : value).data;
  const nested = object.safeParse(body?.error ?? body?.detail).data;
  const code = nested?.code ?? body?.code ?? body?.error;
  const normalized = typeof code === 'string' ? code.toUpperCase() : '';
  return new MekoError('meko_tool_error', {
    category: 'tool',
    providerCode: providerCodes.has(normalized) ? normalized : 'unclassified',
  });
}

function responseError(reason: string) {
  return new MekoError('meko_unrecognized_response', { category: 'parse', reason });
}

function decodeToolPayload(reply: ToolReply) {
  const blocks = reply.content.filter((block) => block.type === 'text');
  if (reply.isError) throw toolError(reply.structuredContent ?? blocks[0]?.text);
  let value = reply.structuredContent;
  if (value === undefined) {
    if (blocks.length !== 1 || !blocks[0]?.text || blocks[0].text.length > 100_000) {
      throw responseError('expected_one_json_text_block');
    }
    value = parseTextBlock(blocks[0].text);
    if (value === undefined) throw responseError('invalid_json_text');
  }
  const envelope = object.safeParse(value).data;
  if (envelope?.error || envelope?.detail) throw toolError(envelope);
  // Hosted FastMCP wraps its JSON text dialect inside structuredContent.result.
  if (typeof envelope?.result === 'string') {
    value = envelope.result.length <= 100_000 ? parseTextBlock(envelope.result) : undefined;
    if (value === undefined) throw responseError('invalid_structured_result_json');
  }
  const body = object.safeParse(value).data;
  if (body?.error || body?.detail) throw toolError(body);
  return value;
}

function memoryRows(reply: ToolReply) {
  const parsed = payloadSchema.safeParse(decodeToolPayload(reply));
  if (!parsed.success) throw responseError('expected_results_array');
  return parsed.data.results;
}

function summarizeRow(row: Record<string, unknown>) {
  return {
    id: memoryId.safeParse(row.memory_id).data ?? memoryId.safeParse(row.id).data ?? null,
    score: score.safeParse(row.score).data ?? null,
  };
}

function memoryRecord(row: Record<string, unknown>) {
  return {
    id: summarizeRow(row).id,
    text: z.string().max(6000).safeParse(row.text ?? row.memory ?? row.content).data ?? null,
  };
}

export class MekoRateLimit extends DependencyError {
  constructor(readonly retryAfterMs: number) { super('meko_http_429'); }
}

export class MekoWriteNotSent extends DependencyError {
  constructor(code: string, readonly retryAfterMs?: number) { super(code); }
}

export function parseMemorySearch(reply: ToolReply) {
  return { matches: memoryRows(reply).slice(0, 3).map(summarizeRow) };
}

function toolReply(reply: unknown): ToolReply {
  if (typeof reply !== 'object' || reply === null || !('content' in reply) || !Array.isArray(reply.content)) {
    throw responseError('missing_mcp_content');
  }
  return reply as ToolReply;
}

const knownMethods = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'tools/list', 'tools/call']);
const schemaFields = ['query', 'conversation_id', 'agent_id', 'limit', 'datapack_id', 'run_id'];
const protocolVersion = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/);

async function inspectSearchSchema(client: Client, args: Record<string, unknown>, signal: AbortSignal, log: Diagnostic) {
  let cursor: string | undefined;
  do {
    const list = await client.listTools(cursor ? { cursor } : undefined, { signal });
    const search = list.tools.find((tool) => tool.name === 'memory_search');
    if (search) {
      const schema = search.inputSchema;
      const required = schema.required ?? [];
      const properties = schema.properties ?? {};
      log('memory_search schema', {
        required: schemaFields.filter((field) => required.includes(field)),
        fields: schemaFields.filter((field) => Object.hasOwn(properties, field)),
        additionalPropertiesAllowed: schema.additionalProperties !== false,
        unknownRequiredFields: required.filter((field) => !schemaFields.includes(field)).length,
      });
      if (required.some((field) => !Object.hasOwn(args, field)) ||
          (schema.additionalProperties === false && Object.keys(args).some((field) => !Object.hasOwn(properties, field)))) {
        throw new MekoError('meko_tool_schema_mismatch', { category: 'schema' });
      }
      return;
    }
    cursor = list.nextCursor;
  } while (cursor);
  throw new MekoError('meko_memory_search_unavailable', { category: 'schema' });
}

function categorizeMcpError(error: unknown, signal: AbortSignal) {
  if (error instanceof MekoRateLimit) return new MekoError(error.code, { category: 'http', status: 429, retryAfterMs: error.retryAfterMs });
  if (error instanceof MekoError) return error;
  if (signal.aborted) return new MekoError('timeout', { category: 'timeout' });
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    if (typeof status === 'number' && status >= 400 && status <= 599) {
      return new MekoError('meko_http_' + status, { category: 'http', status });
    }
    return responseError('unexpected_mcp_content_type');
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return new MekoError('timeout', { category: 'timeout' });
    if (error.code === ErrorCode.ConnectionClosed) return new MekoError('meko_transport_error', { category: 'transport' });
    if (/^MCP error -\d+: (?:Structured content does not match|Failed to validate structured content|Tool memory_search has an output schema)/.test(error.message)) {
      return responseError('mcp_output_schema_validation');
    }
    return new MekoError('meko_rpc_error', { category: 'json-rpc', rpcCode: error.code });
  }
  if (error instanceof SyntaxError || error instanceof z.ZodError) return responseError('invalid_mcp_envelope');
  return new MekoError('meko_transport_error', { category: 'transport' });
}

export class HostedMekoReader implements MemoryReader {
  constructor(private readonly key: string, private readonly datapackId: string) {}

  async search(query: string, signal: AbortSignal, diagnostics?: Diagnostic) {
    return this.searchReply(query, agentId, 3, signal, parseMemorySearch, diagnostics);
  }

  async searchRecords(query: string, attributedAgent: string, signal: AbortSignal) {
    const rows = (await this.searchReply(query, attributedAgent, 10, signal, memoryRows)).slice(0, 10);
    return {
      matches: rows.map(summarizeRow),
      records: rows.map(memoryRecord),
    };
  }

  private async searchReply<T>(query: string, attributedAgent: string, limit: number, signal: AbortSignal, parse: (reply: ToolReply) => T, diagnostics?: Diagnostic) {
    const client = new Client({ name: 'contextcon-fraud-lab', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: { Authorization: 'Bearer ' + this.key, 'User-Agent': userAgent },
        redirect: 'error',
      },
      fetch: async (input, init) => {
        const requestSignal = init?.signal;
        const response = await fetch(input, {
          ...init, signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
        });
        if (response.status === 429 && init?.method === 'POST') {
          await response.body?.cancel();
          throw new MekoRateLimit(retryAfterMs(response.headers));
        }
        if (diagnostics) {
          const body = typeof init?.body === 'string' ? object.safeParse(parseTextBlock(init.body)).data : undefined;
          const method = typeof body?.method === 'string' && knownMethods.has(body.method) ? body.method : undefined;
          const headers = new Headers(init?.headers);
          const params = object.safeParse(body?.params).data;
          const args = method === 'tools/call' ? object.safeParse(params?.arguments).data : undefined;
          diagnostics('MCP HTTP', {
            method: method ?? (init?.method === 'GET' ? 'GET stream' : 'other'),
            status: response.status,
            protocol: protocolVersion.safeParse(headers.get('mcp-protocol-version')).data ?? null,
            ...(method === 'initialize' && { offeredProtocol: protocolVersion.safeParse(params?.protocolVersion).data ?? null }),
            ...(args && {
              configuredDatapackSelected: args.datapack_id === this.datapackId,
              conversationUuidSupplied: memoryId.safeParse(args.conversation_id).success,
            }),
            sessionAssigned: response.headers.has('mcp-session-id'),
            sessionSent: headers.has('mcp-session-id'),
            authenticationAttached: headers.get('authorization') === 'Bearer ' + this.key,
            userAgentAttached: headers.get('user-agent') === userAgent,
          });
        }
        return response;
      },
    });
    client.onerror = (error) => {
      // SSE parsing errors arrive asynchronously and can otherwise appear as timeouts.
      const safe = categorizeMcpError(error, signal);
      if (safe.details.category === 'parse') diagnostics?.('MCP response parsing', safe.details);
    };

    let stage = 'initialize';
    try {
      await client.connect(transport, { signal });
      const args = {
        query, datapack_id: this.datapackId, agent_id: attributedAgent,
        // Hosted Meko requires a UUID even for an unscoped, read-only search.
        conversation_id: randomUUID(), limit,
      };
      if (diagnostics) {
        stage = 'tools/list';
        await inspectSearchSchema(client, args, signal, diagnostics);
      }
      stage = 'memory_search';
      const reply = await client.callTool({ name: 'memory_search', arguments: args }, undefined, { signal });
      return parse(toolReply(reply));
    } catch (error) {
      const safe = categorizeMcpError(error, signal);
      diagnostics?.('MCP failure', { stage, code: safe.code, ...safe.details });
      throw error instanceof MekoRateLimit ? error : safe;
    } finally {
      await client.close();
    }
  }
}

export async function readMekoDatapack(key: string, id: string, signal: AbortSignal, diagnostics?: Diagnostic) {
  const response = await fetch('https://api.mekodata.ai/api/v1/datapacks/' + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': userAgent },
    redirect: 'error',
    signal,
  });
  diagnostics?.('Datapack REST HTTP', { status: response.status });
  await response.body?.cancel();
  if (!response.ok) throw new DependencyError('meko_rest_http_' + response.status);
}

// Use the stored conversation identifier returned by the writer tool. This binds the
// write without making any claim about persistent analyst history in the portal.
function retryAfterMs(headers: Headers) {
  const raw = headers.get('retry-after');
  if (raw && /^\d+$/.test(raw)) return Math.max(5000, Number(raw) * 1000);
  const date = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.max(5000, date - Date.now()) : 60_000;
}

export function mekoMemoryGateway(key: string, datapackId: string) {
  const reader = new HostedMekoReader(key, datapackId);
  async function withClient<T>(
    attributedAgent: string, signal: AbortSignal,
    work: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>) => Promise<T>,
  ) {
    const client = new Client({ name: 'contextcon-fraud-lab', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: 'Bearer ' + key, 'User-Agent': userAgent }, redirect: 'error' },
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        });
        if (response.status === 429 && init?.method === 'POST') {
          await response.body?.cancel();
          throw new MekoRateLimit(retryAfterMs(response.headers));
        }
        return response;
      },
    });
    try {
      await client.connect(transport, { signal });
      return await work(async (name, args) => {
        const reply = await client.callTool({ name, arguments: {
          ...args, datapack_id: datapackId, agent_id: attributedAgent,
        } }, undefined, { signal });
        return object.safeParse(decodeToolPayload(toolReply(reply))).data;
      });
    } catch (error) {
      if (error instanceof MekoRateLimit) throw error;
      throw categorizeMcpError(error, signal);
    } finally {
      await client.close();
    }
  }

  return {
    search: (query: string, agent: string, signal: AbortSignal) => reader.searchRecords(query, agent, signal),
    async read(id: string, agent: string, signal: AbortSignal) {
      return withClient(agent, signal, async (call) => {
        const row = await call('memory_get_by_id', { memory_id: id, conversation_id: randomUUID() });
        if (!row) throw responseError('invalid_memory_lookup');
        const record = memoryRecord(row);
        if (record.id !== id || record.text === null) throw responseError('invalid_memory_lookup');
        return record;
      });
    },
    async recent(agent: string, signal: AbortSignal) {
      return withClient(agent, signal, async (call) => {
        const payload = await call('memory_get_all', { conversation_id: randomUUID(), page: 1, page_size: 30 });
        const parsed = z.array(object).safeParse(payload?.memories);
        if (!parsed.success) throw responseError('invalid_memory_inventory');
        return parsed.data.slice(0, 30).map(memoryRecord);
      });
    },
    /**
     * Knowledge-base search. Observed live on 22 November 2026 (the docs omit the shape):
     * { count, results: [{ id, chunk_text, document_id, distance, rank, rerank_score, match_type, metadata_filters }] }.
     * Chunks start with "Document: <title>" and "Section: <path>" lines. Hits carry no filename.
     */
    async knowledgeSearch(query: string, agent: string, signal: AbortSignal, limit = 5) {
      return withClient(agent, signal, async (call) => {
        const payload = await call('knowledgebase_search', { query, conversation_id: randomUUID(), limit });
        const list = Array.isArray(payload?.results) ? payload.results as unknown[] : [];
        const text = (value: unknown, max = 4000) => typeof value === 'string' ? value.slice(0, max) : null;
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
        const hits = list.slice(0, limit).flatMap((item) => {
          const row = object.safeParse(item).data;
          if (!row) return [];
          return [{
            documentId: text(row.document_id, 100), text: text(row.chunk_text),
            score: number(row.rerank_score), rank: number(row.rank), distance: number(row.distance),
          }];
        });
        return { fields: Object.keys(payload ?? {}).sort(), hitFields: Object.keys(object.safeParse(list[0]).data ?? {}).sort(), hits };
      });
    },
    async write(text: string, attributedAgent: string, signal: AbortSignal) {
      let sent = false;
      try {
        return await withClient(attributedAgent, signal, async (call) => {
          const conversation = await call('conversation_create', {
            session_id: randomUUID(), title: 'ContextCon memory publication',
          });
          const id = z.string().min(1).max(200).safeParse(conversation?.id).data;
          if (!id) throw responseError('missing_write_conversation_id');
          sent = true;
          const written = await call('memory_add', { text, conversation_id: id });
          const first = Array.isArray(written?.results) ? object.safeParse(written.results[0]).data : undefined;
          return memoryId.safeParse(first?.id ?? first?.memory_id ?? written?.id ?? written?.memory_id).data ?? null;
        });
      } catch (failure) {
        if (!sent && failure instanceof DependencyError) {
          throw new MekoWriteNotSent(failure.code, failure instanceof MekoRateLimit ? failure.retryAfterMs : undefined);
        }
        throw failure;
      }
    },
  };
}
