# Meko capabilities

Checked against the official product documentation and the organizer's public site on 22 November 2026.

## Verified by direct requests

| Probe | Observed result |
| --- | --- |
| `GET https://api.mekodata.ai/api/v1/health` with a User-Agent, without a key | HTTP 200. Reported database health as OK. |
| MCP initialization at `https://mcp.mekodata.ai/mcp` without authentication | HTTP 401. The gateway returned an authentication error. |
| Unauthenticated `GET https://api.mekodata.ai/openapi.json` with a User-Agent | HTTP 404 from the checked host on this run. The Datapack REST documentation advertises this URL. |
| Authenticated `npm run verify:meko` | REST datapack read 200. MCP initialize 200 and initialized notification 202. `tools/list` and `memory_search` returned 200 over Streamable HTTP. Verified an empty result, then matched the exact ID of a temporary synthetic memory. |

The authenticated deployment negotiated MCP `2025-11-25`. It omitted `Mcp-Session-Id` and returned 405 for the optional standalone GET stream. Both bearer authentication and the configured User-Agent were present. The search sent the configured datapack UUID.

The live `tools/list` schema requires `query` and `conversation_id` as strings. It additionally accepts `datapack_id`, `agent_id` and `run_id` as optional strings or null, and `limit` as an optional integer. Extra fields are rejected. Omitting `conversation_id` returned a tool validation error with HTTP 200. An empty string, as used in the older Strands sample, also failed. A client-generated UUID worked for cross-conversation reads without opening a stored conversation. Successful calls returned JSON as a string inside `structuredContent.result` as well as in a text block. The parser now accepts that wrapper and preserves the existing formats.

The temporary synthetic memory was verified by UUID, removed, and absent in a follow-up search. The application search path stays read-only. The publication worker owns separate, explicit writes. Portal analyst tracing remains a separate milestone. [Programmatic connection](https://docs.mekodata.ai/integrations/connect-programmatically/) · [Meko Strands audit example](https://github.com/YugabyteDB-Samples/meko-agent-strands-sample/blob/main/agent.py) · [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)


## Confirmed in official documentation

| Capability | Documented interface and constraints | Project status |
| --- | --- | --- |
| Cloud authentication and datapacks | API keys are configured in the portal. Send `Authorization: Bearer <key>` and a User-Agent. The hosted MCP endpoint is shared across datapacks, selected by `datapack_id`. REST describes or manages datapacks and related resources. | Backend fixes the endpoint, reads a single configured datapack and keeps credentials in its local environment. |
| Hybrid memory retrieval | MCP `memory_search` ranks personal and the user's promoted memories. Its documented success has a `results` array. `score` is the fused rank and `raw_similarity_score` is cosine similarity. An error-shaped response is a failure. | Node/TypeScript uses the official MCP TypeScript client over Streamable HTTP. It requests three results and records UUIDs and scores when recognized. The parser accepts the hosted result wrapper, direct structured content and a JSON text block. Empty and non-empty hosted replies were verified. |
| Broad context search | `context_search` separates memory, knowledge and conversations into source buckets, including source health and a quality band. An empty bucket can be a search failure. | Documented. Not used. Knowledge passages come from `knowledgebase_search` and are bound to approved records. |
| Memory lifecycle | MCP `memory_add`, `memory_get_by_id`, `memory_list`, `memory_update` and `memory_delete_by_id`. Repeated adds can duplicate text. Update and delete require the original writer's agent ID. Consuming data across agents within one user differs from promoted collective knowledge. | Synthetic observations and approved fingerprint versions use durable publication and reconciliation. |
| Sharing and namespaces | `memory_search` searches the current user's namespaces. `agent_id` attributes the call. Promotion moves private memory into shared knowledge, with owner or maintainer grants. Shared knowledge is available in the same pack. The pricing page lists multi-user pack sharing and role-based access under Pro. | Verified for app-owned agents under the configured Free account. The app uses separate datapacks for provisional and confirmed documents, and controls publication and reuse in PostgreSQL. Agent names are insufficient for privacy isolation. |
| Knowledge ingestion | REST or MCP asks for a presigned upload. Send the permitted bytes to storage and wait for indexing. MCP `knowledgebase_search` returns passages with document references. | Live verified on 22 November 2026 for six approved playbooks: REST `upload-url`, a multipart POST to storage, then `document-status` until `completed`. Identical bytes return `already_uploaded`. See [Knowledge-base search](#knowledge-base-search). |
| Conversations | MCP create, add message, read, list, update and delete. Some operations require the owning agent ID. Some searches can include wider datapack conversation history. | Planned for persistent synthetic analyst questions with scope controls. Conversations remain out of the current detection context. |
| Artifacts | `artifact_put` and `artifact_get` and REST counterparts store/fetch by SHA-256 hash. Free artifacts can be soft-expired after 30 idle days. | Planned. App-owned report metadata can associate case versions with content hashes. Meko hashes identify bytes. |
| Traces and token usage | The portal exposes observed conversation decisions and Langfuse traces on Free. Compliance audit export needs Pro. MCP `track_token_usage` records attributed token usage. Native self-learning diagnostics depend on deployment and tool availability. | Current audit traces are built by the app for every decision. LLM usage comes from the configured model's response. No private reasoning is requested or persisted. This app has no authenticated evidence of native Meko traces or access to a supported API for exporting them. |

Sources [MCP server and tool reference](https://docs.mekodata.ai/reference/mcp-server/) · [Datapack REST interface](https://docs.mekodata.ai/reference/datapack-api/) · [Authentication and connection](https://docs.mekodata.ai/use-meko/connect/) · [Memory retrieval](https://docs.mekodata.ai/concepts/how-meko-learns/memory-retrieval/) · [Observability](https://docs.mekodata.ai/guides/observability/) · [TypeScript MCP client](https://ts.sdk.modelcontextprotocol.io/client.html)

## Quotas and zero-cost operation

Meko Cloud Free advertises $0 with no card, up to 10 datapacks, 1,000 monthly conversations, 10,000 monthly retrievals, 10 million WorkbenchLM tokens, 100 MB of knowledge storage and 5 MB per file. REST documents a default 60 requests per minute per key with burst 10, and 10 requests per second per IP with burst 20. A REST quota is separate from quotas on MCP tools. The fast path makes no Meko calls. Each selected specialist can make one bounded attributed search and an eligible transfer can search the confirmed pack. Risk handoff reads at most two exact IDs. Local policy remains available during rate limiting or outages. [Meko pricing](https://mekodata.ai/pricing/) · [REST errors and limits](https://docs.mekodata.ai/reference/datapack-api/#read-errors)

Google documents free standard text input and output on the configured Gemini 3.1 Flash-Lite model. Verify current project allowances in AI Studio before running. Ollama runs locally through `POST /api/chat`, whose token counts describe local prompt and output evaluations. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) · [Ollama chat reference](https://docs.ollama.com/api/chat)

## Collective learning live contract

The same existing key received HTTP 200 for authenticated REST reads and completed live MCP search against both separately configured datapacks. This verifies the grants of the configured key and its account.

| Live tool | Required advertised fields | Application use |
| --- | --- | --- |
| conversation_create | None reported by the deployed schema | Publication passes a fresh session ID, datapack, title and originating agent. The returned conversation ID is accepted as opaque. |
| memory_add | text, conversation_id | Write a synthetic observation or analyst-verified version to the configured pack. |
| memory_search | query, conversation_id | Search using a fresh UUID and the required pack and attribution. |
| memory_get_by_id, memory_delete_by_id | memory_id, conversation_id | Available for inspection and targeted fixture cleanup. |
| memory_update | memory_id, text, conversation_id | Advertised. App correction publishes a new version and marks the previous registry entry superseded. |

Do not use read trace UUIDs to infer durable analyst conversation history. The app has not verified analyst message persistence or portal replay. [Meko MCP reference](https://docs.mekodata.ai/reference/mcp-server/) · [Datapack API](https://docs.mekodata.ai/reference/datapack-api/)

The repeated-seed incident showed that ranked search can omit stored, acknowledged documents. Hosted `memory_get_by_id` returned the exact documents through the existing structured-result wrapper. Hosted `memory_get_all` accepted a 30-record page and returned the omitted incident record in the newest inventory. These are separate lookups from semantic recall. [Hosted MCP reference](https://docs.mekodata.ai/reference/mcp-server/#memory-tools)

## Runtime discovery and risk handoff

Normal investigations build confirmed-pack queries from current evidence, then verify any result against the publication registry before reuse. The hosted smoke confirmed the active corrected fingerprint for two variants and rejected reuse for three controls. Earlier-signal handoff in the risk pack uses a previously verified pointer and checks the full remote document. This kept an independent earlier Behaviour/Login observation attributable when a later Transaction specialist read it during a different session. The worker never waits for remote indexing on an API request. Availability still depends on model completion, publication and hosted visibility. [Live results](BENCHMARKS.md)

## Knowledge-base search

Observed live on 22 November 2026 against the confirmed datapack after uploading the approved playbooks. The documentation does not describe this response shape.

- **Input schema** (from `tools/list`): `query`, `conversation_id` and `datapack_id` are required. `agent_id`, `limit` (default 10) and a deprecated `skip_conversation` are optional. Additional properties are rejected.
- **Result:** `{ count, results: [...] }`. Each result has `id`, `chunk_text`, `document_id`, `distance`, `rank`, `rerank_score`, `match_type` (`hybrid`) and `metadata_filters`.
- **Chunk text** begins with `Document: <title>` and `Section: <title> > <heading>`, followed by the section text with list markers removed. Hits carry no filename.

The app binds each hit to an approved registry version by its title. The section text must also appear in that version's body, ignoring whitespace and list markers. Unbound chunks are counted as unverified and never reach a model. Live probes returned the takeover and credential-stuffing sections for a takeover query and the velocity checklist for a payee query, with 0 unverified hits.

Node 22's built-in `fetch` ignores `HTTPS_PROXY`. Behind a proxy that injects credentials, as in a Claude Code cloud session, set `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS` to the proxy CA. A direct connection with `MEKO_API_KEY` needs neither.

