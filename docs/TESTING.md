# Testing

| Command or probe | Scope |
| --- | --- |
| `npm ci`, `npm run typecheck`, `npm run build` | Reproducible package install and TypeScript compilation. |
| `npm test` | Event validation, deterministic generation and label separation, risk policy, Meko response fixtures. |
| `npm run test:postgres` | Real PostgreSQL migrations, actual HTTP requests, idempotency and conflicts, feature windows, agent evidence validation, fallback, lease fencing. |
| `npm run verify:llm` | A real structured check of the configured inference provider with its reported usage. |
| `npm run verify:meko` | Authenticated REST Datapack read and MCP `memory_search`. Needs the free Cloud key and datapack UUID. |
| `npm run simulate -- --seed 22` | Credential-free end-to-end replay through the compiled API and PostgreSQL. |

The PostgreSQL suite creates an isolated schema in the configured disposable test database and removes that schema at teardown. The external calls in automated tests use labelled test doubles. Use a dedicated test database and keep keys out of CI. The GitHub Actions workflow uses its own service PostgreSQL container.

## Executed on 22 November 2026

- Type checking and compilation passed. Seven unit tests and nine PostgreSQL integration tests passed. The PostgreSQL suite ran against both native PostgreSQL 18.4 and the Docker Compose image.
- The Compose database reached healthy, the migration applied, and a second run reported the schema current. The compiled API returned healthy. The Docker rules-only replay processed 94 events and recorded zero LLM calls. Replaying it returned 94 duplicates and left 94 event and case rows.
- Ollama 0.30.10 with `qwen2.5:3b` answered the structured health probe. It reported 27 input and 10 output tokens on that call. The live specialist accepted one takeover login on the first call, reporting 232 input and 118 output tokens with an advisory allow. The policy kept step-up. A separate takeover login failed validation twice and fell back to step-up. [Observed probes](../benchmarks/ollama-probes.json)
- Meko public health returned 200 and unauthenticated MCP initialization returned 401. The initial unauthenticated run preceded the configured Meko check below. Gemini has no live credential check on this machine.

## Authenticated hosted Meko check

- Ran `npm run verify:meko` in Git Bash with the configured datapack. REST read, MCP initialization, live discovery and a zero-match search passed. The hosted request used protocol `2025-11-25`, the required conversation UUID and the configured datapack.
- Added a temporary synthetic memory and verified that the same CLI returned its exact UUID. A follow-up search confirmed removal. These live results are separate from the regression fixtures for transport, validation and parsing.
- One runtime lookup timed out at the original 3.5-second budget. Three subsequent direct reads completed with a 12-second budget. An existing `.env` entry takes precedence over the new default.

## Collective-learning checks

- Typecheck, build, 15 unit/contract tests and 11 PostgreSQL tests passed. The PostgreSQL tests use real transactions and remote test doubles to exercise concurrent feedback, isolated datapack routing, correction, stale documents, lost acknowledgements and delayed indexing.
- Verified both configured datapacks against live REST and MCP using the same key. Real application jobs made confirmed fingerprints and a provisional Transaction observation searchable. The provisional memory ID was absent from a targeted search of the confirmed pack.
- Both A/B/C/D runs completed against hosted Meko and local Ollama. The two-pack rerun verified six provisional observations and two confirmed fingerprint versions after queue drain. The tool schema and read/write shapes were checked live. Meko service outages, ambiguous writes, 429s and some invalid outputs use repeatable local test doubles. The Groq adapter was tested with those fixtures. No Groq key was configured for live requests.

## Publication reliability regression

The tests cover new processes reclaiming pending work, late exact-ID visibility, lost acknowledgements when ranked search misses, duplicate write avoidance, HTTP 429 cooldown persistence, and same-seed runs sharing a remote gateway and separate real PostgreSQL schemas. Existing cases cover interrupted investigation leases, stale and superseded memory, and legitimate matching events. Hosted lookups and demo runs are recorded separately in [Benchmarks](BENCHMARKS.md).

## Multi-agent and temporal milestone

- Typecheck, build, 23 unit tests and 29 PostgreSQL integration tests passed against the configured local disposable database. The graph suite exercises typed relationships, shared infrastructure, cutoff, two-hop confirmation, cycle prevention and traversal caps. PostgreSQL assertions verify role routing, supported evidence IDs, conflicts and missing agents, cross-session publication handoff and rejection of late or wrong-account observations. Additional cases cover already-arrived future-dated events, ordinary ranked discovery in the extended orchestration, rejection of an outside-registry candidate, idempotent fingerprint revocation with a stale ranked hit, and a safe retrieval miss.
- The PostgreSQL suite uses model and Meko fixtures. The live hosted tests are separate. `demo:signals` verifies acknowledged publication and the later specialist's remote read. `evaluate:ranked` verifies evidence-derived hosted ranked searches. `demo:learn -- --resume-schema …` rechecks the durable historical loop without regenerating settled investigations.
- `evaluate:early` evaluates alerts, lead time, attempted operations, explicit challenge outcomes and executed impact from the same generated event tape. A step-up counts as an alert. Only a denied challenge or direct block prevents modeled impact. The seeds, diagnostics and observed metrics are recorded in [Benchmarks](BENCHMARKS.md).

## Verified-pattern policy milestone

- On 22 November 2026, typecheck, build, 33 unit tests and 33 PostgreSQL integration tests passed against PostgreSQL 16. CI uses 18.4. New unit tests cover ordered-prefix matching, rule-subset strictness, the minimum step and evidence weight, step compaction, and the scoring branch, including a failed login that stays an observation. They also cover the opt-in hard-negative corpus and the first/repeat encounter split.
- `test/memory-policy.postgres.ts` runs real ingestion and the publication worker with the local stand-in store. It checks that an unpublished pattern is unusable, shadow records without enforcing, and enforce blocks another account's reset with a full trace. Identical confirmations corroborate one pattern. A legitimate customer's block can be corrected with a condition: the customer is then relieved, while the attack is still blocked at the transfer. Revocation disables the pattern, `off` adds nothing to the trace, and the origin account never matches its own pattern.
- `evaluate:early --memory compare [--hard-negatives]` produced the results in [Benchmarks](BENCHMARKS.md#memory-that-changes-the-decision). Set `EVAL_DEBUG=1` to print the underlying error when the evaluator fails.

## Playbooks and workspace milestone

- On 22 November 2026, typecheck, build, 38 unit tests and 35 PostgreSQL tests passed, and the workspace built. CI now builds `web/` too.
- **Unit tests:**
  - every playbook parses with known rule triggers
  - unapproved files are rejected
  - the REST knowledge-base upload sends form fields before the file, sends no API key to storage, skips already-uploaded bytes and treats an early 404 status as awaiting upload
  - passage binding accepts only verbatim approved section text
- **PostgreSQL tests:**
  - registry versioning refuses an edited file without a new version
  - alerted cases carry matching playbooks and allowed cases carry none
  - the workspace API serves overview, filtered lists with exact cursor paging, session context, patterns and playbooks
  - the server-sent-event stream delivers newly decided cases
- **Live Meko:**
  - `verify:meko` passed for both packs
  - `playbooks:sync` uploaded six playbooks to `completed`, and the knowledge-base search shape was recorded
  - runtime passages were bound with 0 unverified
  - the hosted memory comparison is recorded in [Benchmarks](BENCHMARKS.md#hosted-meko-rerun)
- **Browser:** checked with Playwright at 1440 px in light and dark themes and at 390 px with no horizontal overflow. Confirm fraud in the UI produced a published pattern within seconds.

