# Manual setup

Open Git Bash in VS Code and work from `C:\Users\sansk\Downloads\CONTEXTCON`. Keep credentials in the root `.env`, which Git ignores. The credential-free setup costs nothing and runs in `rules` mode.

## 1. Node.js and PostgreSQL

**Why.** Node runs the TypeScript app. PostgreSQL persists events and builds features with time-window queries.

1. Run `node --version`, `npm --version` and `docker compose version`. Install Node.js 22.22+ from the [Node.js download page](https://nodejs.org/en/download) and Docker Desktop from [Docker](https://www.docker.com/products/docker-desktop/) if missing. Docker lists its [free personal/educational usage terms](https://docs.docker.com/subscription/desktop-license/). Native PostgreSQL is another option.
2. Open Docker Desktop and wait for the engine. From the project root copy the local defaults once with `test -f .env || cp .env.example .env`, then run `npm ci`. The example database credentials are scoped to local development.
3. Run `docker compose up -d --wait db`, then `npm run db:migrate`. The Compose host port is `POSTGRES_PORT` in `.env`. If 55432 is occupied, choose another free port and change both DB URLs to match.
4. Run `npm run dev`. Check `curl -fsS http://127.0.0.1:3001/health`. It should report `status: ok` and `database: ready`. Use your configured `PORT` if you changed it.
5. For the integration suite, create the disposable test database once with `docker compose exec -T db createdb -U contextcon contextcon_test`. Set `TEST_DATABASE_URL` in `.env` to that database and run `npm run test:postgres`. Expect the PostgreSQL suite to report success.

If the Docker named pipe is unavailable, wait for Docker Desktop or run `docker info` to confirm engine status. If the API starts but returns 503 on health, verify the database URL and run the migration. With an existing native [PostgreSQL](https://www.postgresql.org/download/) install, create a dedicated local user and separate `contextcon` and `contextcon_test` databases. Put their URLs into `.env`. URL-encode special characters in a PostgreSQL password.

**Payment.** Running Node and native PostgreSQL locally is free. The Docker Desktop Personal tier permits eligible personal and educational use. Local setup needs no cloud subscription or card.

## 2. Meko Cloud Datapack and API key

**Why.** The live Phase 2 retrieval slice needs an authenticated Datapack. The app uses the public Cloud MCP endpoint and does not install an IDE extension.

1. Open [Meko Cloud](https://cloud.mekodata.ai/), sign up or sign in, and finish any browser verification the portal requires. Keep the account on Free. Check **Settings → Pricing** for your plan. [Meko pricing](https://mekodata.ai/pricing/)
2. In **Datapacks → Add Datapack**, create a dedicated synthetic pack such as `contextcon-confirmed-patterns`. Use the default agent in the configuration wizard and keep the pack private. The fraud brief calls for separate packs for risk signals and confirmed fingerprints. Create or select a separate private `contextcon-risk-signals` pack for provisional observations. Copy its UUID into `MEKO_RISK_SIGNALS_DATAPACK_ID` in the root `.env`. Keep the confirmed pack UUID in `MEKO_DATAPACK_ID`. The app rejects the same UUID for both. [Datapack management](https://docs.mekodata.ai/use-meko/datapacks/)
3. Open the dedicated pack's **Connect** dialog. Copy its datapack UUID from the shown connection details, and paste the UUID into `MEKO_DATAPACK_ID` in the root `.env`. The cloud endpoint is fixed at `https://mcp.mekodata.ai/mcp`.
4. In **Settings → API Keys → Generate API key**, name the key `contextcon-local` and copy the value starting with `mko_tkn_` when it is shown. Put it in `MEKO_API_KEY` in `.env`. Enter the key without the `Bearer` prefix. The backend sends it as a bearer credential and includes a User-Agent. [Meko API keys](https://docs.mekodata.ai/use-meko/api-keys/)
5. From Git Bash, run `npm run verify:meko`. The verifier prints REST and MCP HTTP statuses, the negotiated protocol, and the live `memory_search` argument names. Success ends with `Authenticated Meko MCP memory_search succeeded`. Zero matches is valid. The reader generates the required `conversation_id` on each request. Your existing key and datapack UUID are the only Meko credentials needed.
6. To verify a stored memory, save a synthetic fact with a distinctive phrase in the demo pack. After indexing, run `npm run verify:meko -- --query "YOUR SYNTHETIC PHRASE"`. If you know the fixture's memory UUID, append `--expected-memory-id "$fixture_id"` using a local Bash variable. The command prints whether that exact UUID was returned and exits nonzero if it was absent. Keep searches synthetic. [WorkbenchLM](https://docs.mekodata.ai/guides/workbench-lm/)
7. Set `INVESTIGATION_MODE=meko`, configure one model below, and restart the API. If your `.env` still sets `MEKO_TIMEOUT_MS=3500`, change it to `MEKO_TIMEOUT_MS=12000` before restarting. An authenticated cold read exceeded 3.5 seconds. Run `npm run simulate -- --seed 23 --scenario takeover`. Open a printed step-up case and inspect `trace.context`. A rules-only replay of the same seed returns its earlier immutable trace.

**Troubleshooting.** An HTTP 405 for `GET stream` is expected on the hosted endpoint observed here when MCP POSTs succeed. HTTP 401 usually points to the key. HTTP 403 or 404 on the REST datapack read points to access or an incorrect datapack UUID. On 429, check the Free limits and wait for the cooldown. `meko_tool_conversation_id_required` indicates a client missing the now-required field. Restart with current source or rebuild for `npm start`. `meko_unrecognized_response` identifies a response parsing issue. Share the diagnostic category and reason when troubleshooting. The verifier omits credentials, IDs, query text, raw error bodies and matches. [Meko MCP reference](https://docs.mekodata.ai/reference/mcp-server/) · [Strands sample](https://github.com/YugabyteDB-Samples/meko-agent-strands-sample)

**Payment.** Meko advertises Free at $0 with no card. Keep sharing within the app's agents and its own account. The pricing page lists multi-user sharing and role-based access under Pro.

## 3. Choose one model

### Ollama locally

1. Install or open [Ollama](https://ollama.com/download). Run `ollama list`. If needed, run `ollama pull qwen2.5:3b` to download the [model](https://ollama.com/library/qwen2.5:3b).
2. Start Ollama if needed. A running desktop instance already provides `http://127.0.0.1:11434`. In `.env`, set `LLM_PROVIDER=ollama` and `OLLAMA_MODEL=qwen2.5:3b`. Use `INVESTIGATION_MODE=agents` for local review alone or `meko` for the retrieval slice.
3. Run `npm run verify:llm`. Expect `Structured model response verified: ollama qwen2.5:3b` and provider-reported token counts. For the local specialist demo, set `LLM_TIMEOUT_MS=60000`. The verified full review on this machine took about 19 seconds, and other responses required fallback. A connection error can mean the service is down. An HTTP 404 can mean the selected model needs to be pulled.

**Payment.** Local inference needs no account or card. Model downloads use local disk and network bandwidth.

### Gemini Developer API Free tier

1. Sign in to [Google AI Studio](https://aistudio.google.com/apikey) and create an API key in a project in the Free tier. Complete any account verification Google requires. Keep billing disabled and confirm the tier in the project's dashboard before use.
2. In `.env`, set `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` to the generated secret, and `GEMINI_MODEL=gemini-3.1-flash-lite`. Set `INVESTIGATION_MODE=agents` or `meko` as needed. Do not use keys tied to billable projects.
3. Run `npm run verify:llm`. Expect `Structured model response verified: gemini gemini-3.1-flash-lite` and provider usage if returned. On 403, check project access, region and verification. On 429, check the project's actual limits in [AI Studio Rate Limits](https://aistudio.google.com/rate-limit). Switch to local Ollama if the free model is unavailable.

**Payment.** Google's pricing lists standard text input and output on this model as free of charge on the Free tier. The free path uses a project without linked billing. Availability and quotas vary by project. Free-tier content may be used by the provider to improve products, so keep inputs synthetic. ChatGPT/Codex and Gemini API subscriptions and credentials are separate. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

### Groq Free tier

1. Sign up at [Groq Console](https://console.groq.com/) and confirm the organization is on Free. Do not add billing or upgrade. Create a key under [API Keys](https://console.groq.com/keys), then save it as `GROQ_API_KEY` in `.env`. Keep the key local.
2. Set `LLM_PROVIDER=groq`, `GROQ_MODEL=openai/gpt-oss-20b`, and `GROQ_JSON_MODE=strict`. Leave `GROQ_INVESTIGATOR_MODEL` blank for the same model or set it to `openai/gpt-oss-120b`. Groq lists both as strict-schema models, with published Free limits of 30 RPM, 1,000 RPD, 8,000 TPM and 200,000 TPD per model. Actual limits are organization-specific. Check [your Limits page](https://console.groq.com/settings/limits). [Rate limits](https://console.groq.com/docs/rate-limits) · [Structured Outputs](https://console.groq.com/docs/structured-outputs)
3. Verify from Git Bash. The result should include `Structured model response verified: groq` and token counts. A 401 points to the key, a 403 can indicate model permissions, and a 429 indicates a rate limit. A 400 in strict mode can indicate an unsupported choice or schema. Use `best_effort` or `json_object` only if the selected model documents that capability.

```bash
LLM_PROVIDER=groq npm run verify:llm
LLM_PROVIDER=groq GROQ_MODEL=openai/gpt-oss-120b npm run verify:llm
```

Set `LLM_OLLAMA_FALLBACK=on` to opt in to one local fallback attempt after the primary fails or is unavailable. The application retries a schema failure once and honors a short 429 `Retry-After` once. A longer wait takes the fallback path. Use `LLM_PROVIDER=ollama` for repeatable local runs independent of hosted quotas. The installed 3B model is the starting point for this 15.8 GiB RAM, Iris Xe system. No larger model is required for the current workflow.

## 4. Collective learning workflow

Run from the root in Git Bash. The demo uses independent PostgreSQL schemas and synthetic events. It publishes demonstration memories into the two packs you configured. Use dedicated demo datapacks. The seed determines the synthetic inputs, while each fresh execution gets its own unique schema and confirmed-memory pointer registry. Repeat the same seed to exercise isolation. The demo starts a fresh process for B and compares B against the identical input without Meko. It reads its confirmed fingerprints by exact Meko ID and verifies the returned content. Ordinary application recall still uses Meko ranked search. Historical demo records are retained for audit.

```bash
npm run db:migrate
npm run verify:meko
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:3b LLM_TIMEOUT_MS=60000 npm run demo:learn -- --seed 661022
```

In Meko mode, the HTTP server runs a background publication loop by default. To drain queued jobs independently of the server, run the worker below against the same app database. Omit `--watch` to process at most one due job.

```bash
npm run memory:work -- --watch
```

For manual analyst feedback, start the API in `meko` mode. Set `case_id` to the settled synthetic case UUID and `publication_id` to the earlier broad fingerprint's publication UUID before running the respective commands.

```bash
# Confirm a known synthetic fraud case
curl -fsS -X POST "http://127.0.0.1:3001/api/cases/$case_id/feedback" \
  -H 'Content-Type: application/json' -d '{"verdict":"fraud_confirmed"}'
curl -fsS "http://127.0.0.1:3001/api/cases/$case_id/publications"

# Submit the repair from the legitimate case that matched the broad fingerprint
curl -fsS -X POST "http://127.0.0.1:3001/api/cases/$case_id/feedback" \
  -H 'Content-Type: application/json' \
  -d "{\"verdict\":\"legitimate_correction\",\"publicationId\":\"$publication_id\",\"require\":\"recent_reset\"}"
```

An HTTP 202 queues feedback. `indexing` means the write was acknowledged and verification is pending. Acknowledged IDs are checked with `memory_get_by_id` and the exact stored document. `uncertain` means the write may have reached Meko. If the ID was lost, the worker looks for the original marker in ranked search and the newest 30 records and never resends an ambiguous write. `failed` means the adapter encountered a definitive pre-submit problem. The worker backs off per row, honors HTTP 429 `Retry-After`, and persists the queue delay. The local feedback endpoint is intended for the developer or demo analyst.

### Resume an interrupted run

Use the schema printed by your run. This example resumes the investigated run. Keep the same provider and model settings to preserve the benchmark conditions.

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:3b LLM_TIMEOUT_MS=60000 \
  npm run demo:learn -- --resume-schema contextcon_demo_661072_6793
```

Resume migrates the existing demo schema, reuses settled decisions and analyst feedback, and waits on individual durable publication IDs. It can give exhausted read-only reconciliation a small additional attempt budget. A pending investigation with a live lease can be resumed again after the lease expires. Follow the reported case, publication ID, state, and operation. If an uncertain job without an ID remains invisible, inspect the designated pack before attempting any operator-driven repair. Do not delete unrelated memories.

### Revoke a confirmed fingerprint

Use the local analyst API to retire an invalid active fingerprint without publishing a replacement. With the API running in Meko mode, enter its publication UUID from the case publications response. The reason can be `invalid_confirmation` or `incorrect_generalization`. The response retains delivery state and adds `revoked_at` and `revocation_reason`. Repeating the same request returns the same timestamp. Meko may continue returning the out-of-use document in search results. The case trace records and rejects it as `revoked`.

```bash
read -rp 'Fingerprint publication UUID: ' publication_id
curl -fsS -X POST "http://127.0.0.1:3001/api/memory-publications/$publication_id/revoke" \
  -H 'Content-Type: application/json' -d '{"reason":"invalid_confirmation"}'
```

## 5. Early takeover and shared risk intelligence

The extended investigation profile is the default. Run the migrations to add the graph indexes and fingerprint revocation fields to your existing database. The API uses the same two datapacks and one local model from the earlier setup. No new key, model download or cloud subscription is required. Set `MEKO_AUTO_PUBLISH=off` if you run a standalone worker or want publications to stay queued. Set `INVESTIGATION_PROFILE=legacy` to use the former API routing and early rules. The `demo:learn` benchmark keeps its original profile.

```bash
cd /c/Users/sansk/Downloads/CONTEXTCON
npm run db:migrate
npm run typecheck
npm test
npm run test:postgres
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:3b LLM_TIMEOUT_MS=60000 npm run --silent demo:signals
```

`demo:signals` writes only synthetic provisional observations into the configured risk pack. It waits for one publication in a bounded test harness and then submits a new-payee event in another session. Expect `shared` to name the earlier case, origin role, receiving role, and hosted memory ID. Normal API requests do not wait for indexing. A fast follow-up may use local evidence before the new observation becomes remotely available.

For ranked confirmed-pattern discovery, use the schema printed by a completed `demo:learn` run with both fingerprint versions. The evaluator makes read-only Meko calls using current rule evidence. The expected applicability classification stays in the evaluator.

```bash
read -rp 'Completed demo schema: ' demo_schema
npm run --silent evaluate:ranked -- --schema "$demo_schema" --seed 50271
```

Use the following modes for a matched local benchmark. The `2000` cap produces 1,999 attempted events with the documented held-out settings. The small three-mode smoke holds the same model settings for both agent paths and starts with a cold local fingerprint registry. `demo:learn` and `evaluate:ranked` exercise the warmed path. Keep the large comparison in `rules` mode for an inexpensive run. Local model latency can dominate reviews. The app schedules specialists serially within a case. Spread out live runs if you hit a hosted Free-tier limit.

```bash
mkdir -p work
npm run --silent evaluate:early -- --suite evaluation --seed 7403 --events 2000 --mode rules --profile legacy --json > work/early-legacy.json
npm run --silent evaluate:early -- --suite evaluation --seed 7403 --events 2000 --mode rules --profile extended --json > work/early-extended.json
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:3b LLM_TIMEOUT_MS=60000 \
  npm run --silent evaluate:early -- --suite evaluation --seed 7403 --events 20 --scenario credential-stuffing --mode all --json > work/early-live.json
```

The replay reports an alert as a step-up or a block. Its offline gate counts prevented synthetic impact only if an explicit block or a failed challenge prevents the intended operation. Use `--suite development --seed 23` when changing the rules. Keep evaluation seeds separate when assessing changes.

## 6. Playbooks and the analyst workspace

1. Load the approved playbooks into the configured confirmed pack's knowledge base. The command waits until Meko reports each document `completed`.

   ```bash
   npm run playbooks:sync -- --probe "account takeover password reset"
   ```

   Without Meko keys, the playbooks stay in the local registry, and cases still list them.
2. Build the workspace once.

   ```bash
   npm run web:install
   ```

   ```bash
   npm run web:build
   ```

3. Set `MEMORY_POLICY=enforce` in `.env`, then start the API with `npm run dev` and open http://127.0.0.1:3001. Without keys, also set `MEMORY_STORE=local`. That in-process stand-in is labelled in the UI and is not valid with `INVESTIGATION_MODE=meko`.
4. In a second terminal, stream a synthetic tape. Remove `--auto-analyst` to confirm cases yourself from the review queue.

   ```bash
   npm run demo:feed -- --auto-analyst --rate 6
   ```

   Use a new `--seed` for each run, because a replayed seed returns stored decisions.

## 7. Hackathon registration and submission

The organizer requires registration and a submission through the [ContextCon event page](https://www.hackerearth.com/lp/challenges/contextcon). Registration asks for name, email, company and profile links. The FAQ allows individuals aged 18+ worldwide and teams up to four. Registration is free. No app environment variable is involved. Verify registration using the event confirmation after signing in. Prepare a public GitHub repository with setup instructions and a recorded demo under five minutes once the collective-learning milestone is verified. See [Hackathon strategy](docs/HACKATHON_STRATEGY.md) for the deadline and deliverables.
