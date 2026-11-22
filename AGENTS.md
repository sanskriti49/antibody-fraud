# Agent handoff: ContextCon fraud lab

Read this first. It tells a coding agent (Codex, Claude Code or a person) what this project is, how it works, what is done, what is left and what must not break. Keep it current: when you finish work, update the [status](#status-22-november-2026) and [backlog](#backlog) sections and add a dated entry to [docs/WORKLOG.md](docs/WORKLOG.md).

## What this is

A submission for **ContextCon 2027, Challenge 03 "Remember the Attacker"**, on fraud detection with shared agent memory on Meko. The deadline is **17 January 2027, 11:59 p.m. Pacific**, which is 18 January, 1:29 p.m. IST. The submission needs:
- a public repository with setup instructions
- a demo recording under five minutes

The brief asks for:
- a synthetic stream of about 2,000 events with planted account takeovers
- agents sharing signals through Meko, with separate datapacks for raw risk signals and confirmed patterns
- detection before takeover succeeds
- false-positive and lead-time measurements
- at least three decision-trace walkthroughs
- fraud playbooks in the knowledge base
- a comparison with and without shared memory

See [docs/HACKATHON_STRATEGY.md](docs/HACKATHON_STRATEGY.md) for the requirement-by-requirement mapping.

**The core idea:** a verified fraud investigation teaches the system to recognise the next similar attack, on any account. Detection is deterministic and explainable. Agents and memory add evidence and context. Only analyst-confirmed memory may change an action, and only through a deterministic rule.

## Invariants: do not break these

1. **Only deterministic code sets the action** (`ALLOW`, `STEP_UP_VERIFICATION` or `BLOCK`). It lives in `src/risk.ts` and `src/cases.ts`. LLM agent recommendations are advisory and are recorded in the trace only.
2. **Memory changes an action only through the verified-pattern policy** (`src/memory-policy.ts`, `evaluateVerifiedPatterns` in `src/learning.ts`). Every one of these must hold:
   - the pattern is analyst-confirmed
   - it is `published`, meaning read back from Meko by exact ID
   - it is not superseded or revoked, and is at most 30 days old
   - it came from a different account
   - at least two ordered steps match, ending on the current event, with at least 40 rule points
   - every analyst condition is present in the session
3. **Provisional risk-pack observations never change an action.** Something suspicious is not proof of fraud.
4. **Playbooks never change an action.** Knowledge-base passages reach a model only after binding to an approved registry version, by title and verbatim section text (`bindKnowledgeHits`).
5. **Meko writes go only through the PostgreSQL outbox** (`memory_publications`) and `LearningService.workOne`. `published` means the stored text was read back and matched.
6. **Ground-truth labels stay in the simulator and evaluator processes.** They never appear in events, traces or Meko.
7. **Synthetic data only.** The API binds to `127.0.0.1` and has no authentication.
8. **Reproducibility.** `MEMORY_POLICY=off` is the default, and `evaluate:early` without `--memory` or `--hard-negatives` must reproduce `benchmarks/early-temporal-7403.json`. Do not change the default corpus. Add new scenarios as opt-in.
9. **Docs report measured results only.** Each claim links to a JSON file in `benchmarks/`, and each limit is stated. Do not overclaim.

## Architecture map

| Area | Files |
| --- | --- |
| HTTP API and server wiring | `src/app.ts`, `src/server.ts`, `src/config.ts`, `src/wiring.ts` |
| Ingestion, feature snapshot, decision, trace | `src/cases.ts`, `src/features.ts`, `src/risk.ts`, `src/events.ts` |
| Verified-pattern policy (memory that blocks) | `src/memory-policy.ts`, `src/learning.ts` (`evaluateVerifiedPatterns`, `activePatterns`) |
| Learning: feedback, fingerprints, outbox worker | `src/learning.ts`, `src/publication-worker.ts` |
| Specialist agents and Investigator (advisory) | `src/investigation.ts`, `src/device-evidence.ts`, `src/graph.ts` |
| Playbooks registry, selection, knowledge-base binding | `src/playbooks.ts`, `playbooks/*.md` |
| Meko clients | `src/integrations/meko.ts` (MCP memory and knowledge search), `src/integrations/meko-knowledge.ts` (REST knowledge upload), `src/integrations/local-memory.ts` (offline stand-in, not Meko) |
| LLM providers | `src/integrations/models.ts` (Ollama, Groq, Gemini) |
| Workspace read API | `src/workspace.ts` |
| React workspace | `web/` (React 19, Vite 7). `web/src/components/CaseDetail.tsx` is the main view. |
| Synthetic data and evaluation | `src/simulator.ts`, `src/early-scenarios.ts`, `src/scripts/evaluate-early.ts`, `src/scripts/demo-feed.ts` |
| Schema | `migrations/001`–`008`. There is no 004; the runner sorts by name. |

Decision flow and rule table: [docs/DECISION_FLOW.md](docs/DECISION_FLOW.md). Design rationale: [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md). Verified Meko contracts: [docs/MEKO_CAPABILITIES.md](docs/MEKO_CAPABILITIES.md).

## Run and verify

Setup steps are in [README.md](README.md) and [MANUAL_SETUP.md](MANUAL_SETUP.md). Node 22.22 or newer and PostgreSQL are required. `docker compose up -d --wait db` starts PostgreSQL 18.4.

The verification set below must pass before every commit. The PostgreSQL suite needs `TEST_DATABASE_URL` pointing to a disposable database.

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run test:postgres
```

```bash
npm run web:build
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | API on 127.0.0.1:3001. It serves `web/dist` when built. |
| `npm run web:dev` | Vite dev server on 5173, proxying `/api` |
| `npm run demo:feed -- --auto-analyst --rate 6` | Stream a synthetic tape into the running API, with a simulated analyst |
| `npm run evaluate:early -- --events 1999 --memory compare [--hard-negatives] [--memory-store meko]` | Memory-off vs verified-pattern policy on the temporal tape |
| `npm run playbooks:sync -- --probe "query"` | Upload playbooks to the Meko knowledge base, wait for indexing, probe search |
| `npm run verify:meko` | Live REST and MCP check of both datapacks |
| `npm run demo:learn -- --seed N` | Historical A/B/C/D agent-reuse demo. Needs a model and Meko. |

Key environment variables: `INVESTIGATION_MODE=rules|agents|meko`, `MEMORY_POLICY=off|shadow|enforce`, `MEMORY_STORE=meko|local`, `MEKO_API_KEY`, `MEKO_DATAPACK_ID` (confirmed patterns and playbooks), `MEKO_RISK_SIGNALS_DATAPACK_ID`, `LLM_PROVIDER=none|ollama|groq|gemini`. The full list is in `.env.example`.

## Status (22 November 2026)

**Done and verified**
- **Deterministic engine.** Rules engine, point-in-time features, graph paths, five agent roles (advisory) and full decision traces.
- **Memory that blocks.** The verified-pattern policy learns from any confirmed case. Repeat confirmations corroborate one pattern, and corrections add conditions. Revocation is supported.
  - **Results:** on the 1,999-event tape, executed attacks fell from 15 to 1 with an unchanged 6.41% legitimate alert rate.
  - **With hard negatives:** across four seeds, the development split and both rule profiles, repeat attacks executed 0 of 48, at the cost of one customer blocked before the analyst corrected the pattern.
  - **Hosted Meko** reproduced the same numbers.
  - Data: `benchmarks/memory-policy-*.json`. Details: [docs/BENCHMARKS.md](docs/BENCHMARKS.md#memory-that-changes-the-decision).
- **Playbooks.** Six approved playbooks are indexed in the Meko knowledge base (all `completed`). They are selected deterministically per case. In Meko mode, verified knowledge passages are traced and given to the Investigator.
- **React workspace.** Live stream, review queue, case evidence, session timeline, memory with matched steps, agents, graph, playbooks, confirm/correct/revoke, and light, dark and phone layouts.
- **Tests.** 38 unit tests and 35 PostgreSQL tests. CI runs typecheck, build, both suites and the web build.

**Not yet verified**
- **No live LLM run since the memory, playbook and workspace work.** No model provider was configured in the cloud session.
- **The A/B/C/D demo was not rerun.** Fingerprint documents now also carry `steps`, so `npm run demo:learn` needs a regression run.
- **The web app has no automated tests.** It was checked manually with Playwright screenshots.

## Backlog

Priority order. Each item names its acceptance check.

### P0: before the submission

1. **Choose the Meko datapacks (owner decision).**
   - **What happened:** the work so far used `meko_default_datapack` b49d… for confirmed patterns and playbooks, and c9e7… for risk signals. The account also has `contextcon-confirmed-patterns` (911e…) and `contextcon-risk-signals` (564b…).
   - **To switch:** set both IDs in `.env`, then run `npm run verify:meko` and `npm run playbooks:sync`.
   - **Cleanup:** b49d… holds six synthetic playbook documents and six synthetic pattern memories. Delete them only with the owner's approval.
   - **Acceptance:** both packs verify and all six playbooks are `completed` in the chosen pack.
2. **Live agent run.**
   - **Setup:** configure Ollama (`qwen2.5:3b`) or Groq, then run `npm run verify:llm`.
   - **Runs:** `npm run demo:learn -- --seed <new>` as an A/B/C/D regression. Then `npm run evaluate:early -- --mode all --memory compare --memory-store meko --events 200 --hard-negatives --json`, keeping events small because agent cases take tens of seconds.
   - **Acceptance:**
     - token and latency telemetry is recorded in `benchmarks/`
     - traces show `knowledge.passages`, and the Investigator input carries `approvedPlaybooks`
     - memory blocks make zero model calls
3. **Demo video under five minutes**, recorded in the workspace with `demo:feed`.
   - **Script:**
     1. A fast allow with zero model calls.
     2. A first takeover gets step-up, and the analyst confirms it in the UI.
     3. A repeat on another account is blocked at the password reset, showing 2 of 4 matched steps and the origin case.
     4. A legitimate recovery customer is blocked, the analyst corrects the pattern to require `amount_spike`, and the next customer passes.
     5. The Playbooks tab and the Meko passages in a trace.
   - **Acceptance:** at least three trace walkthroughs, each written up in `docs/BENCHMARKS.md`.
4. **Submission pass.**
   - The repository is public.
   - The README covers a fresh-clone setup end to end: copy `.env.example`, start the Compose DB, `npm ci`, `npm run web:install`, `npm run web:build`, `npm run dev`, `npm run demo:feed`.
   - Every number in the README and `docs/HACKATHON_STRATEGY.md` links to its benchmark.

### P1: makes the result more credible

5. **Harder attack variants.** Synthetic repeats come from one template per attack type, so recognition is easy. Add opt-in scenarios that reorder steps, skip a step, insert benign steps or change devices mid-session, and add more legitimate look-alikes. Report memory recall on these. Consider generalizing patterns from corroborations, such as the intersection of rules, only if the false-positive rate stays measured.
6. **Extended-rules false positives.** The legitimate-burst false-positive rate is 29% under the extended profile versus 11% under legacy, with no extra attacks prevented. Calibrate the extended profile on the development split and report both profiles.
7. **Web tests.** Add a Playwright smoke test in CI against a seeded database: load each tab, open a case, confirm fraud, check for no console errors and no horizontal overflow at 390 px.

### P2: if time allows

8. **Meko conversations** for persistent analyst questions, and Meko artifacts for exportable case reports. `track_token_usage` for agent calls.
9. **Local stand-in persistence.** The local store is in-process, so pending publications cannot be read back after a restart. Patterns that already published keep working from the PostgreSQL mirror. Document this or persist the stand-in.
10. **Workspace access control** if the app is ever exposed beyond loopback.

## Gotchas

- **Meko through a proxy.** Node 22's `fetch` ignores `HTTPS_PROXY`. In a sandbox where a proxy injects the Meko key, as in Claude Code cloud sessions, run with `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<proxy CA>` and a placeholder `MEKO_API_KEY`. With a real key on a normal machine, nothing extra is needed.
- **Datapack listings expose credentials.** `GET /api/v1/datapacks` returns database connection strings. Never print or commit that response.
- **Migration list in tests.** `test/workflows.postgres.ts` asserts the exact applied migration list. Update it when you add a migration.
- **Playbook versions are immutable.** Editing a playbook file requires increasing its `version`. Otherwise `loadPlaybooks` throws, and the server logs `Playbooks not loaded` and skips the remaining new versions.
- **Replayed seeds return stored decisions.** Event IDs are deterministic per seed, so use a new seed, or a fresh schema or database, for each run.
- **Patterns activate a few seconds after confirmation,** once the worker reads them back. Feeding at hundreds of events per second outruns this.
- **Shared start times in single-scenario corpora.** Episode 0 of each scenario shares a start time, and point-in-time checks mean a pattern from one episode-0 cannot apply to another episode-0. Tests use later episodes.
- **Cursor precision.** Workspace cursors use `sortTime`, a microsecond ISO string, plus `id`. Never round-trip them through a JavaScript `Date`.
- **`MEMORY_STORE=local`** is refused together with `INVESTIGATION_MODE=meko`, and it is labelled as a stand-in in the UI.
- **Two fingerprint types.** `session_sequence` documents drive the policy. Only `transfer_signature` documents let an agent skip a review (the historical A/B/C/D path).

## Conventions

- **TypeScript and validation.** Strict mode, and Zod at every boundary: HTTP bodies, environment, Meko replies and model output.
- **PostgreSQL.** Real PostgreSQL tests in isolated random schemas, with test doubles only for remote services.
- **Commits.** Messages explain why. Work goes on a branch, and `main` is fast-forwarded after verification.
- **Docs.** Plain language and measured claims. Update `docs/WORKLOG.md` (open items and a new dated entry) and this file whenever status changes.
