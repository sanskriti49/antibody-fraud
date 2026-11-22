# ContextCon submission strategy

The organizer lists **17 January 2027 at 11:59 p.m. Pacific** as the submission deadline. In India that is **18 January at 1:29 p.m. IST**. The public submission checklist calls for a demo recording under five minutes and a public or open-source GitHub repository with setup instructions. It labels accompanying architecture and metrics documentation optional. The FAQ requires Meko as the context layer for every theme. [Official ContextCon timeline, checklist and FAQ](https://www.hackerearth.com/lp/challenges/contextcon)

## Challenge 03 · Remember the Attacker

The official fraud brief expects a synthetic stream of up to about 2,000 events with planted takeovers, a multi-agent detector using shared Meko memory, detection timing and false positives, and walkthroughs of at least three decisions. It recommends comparing the same agents with and without shared memory. It describes collective risk signals, hybrid retrieval, fraud playbooks, decision traces, and separate datapacks for risk signals and confirmed patterns. [Official Challenge 03 brief](https://www.hackerearth.com/lp/challenges/contextcon#themes)

### Requirements-to-implementation mapping

The objective is earlier justified intervention before account takeover or financial impact, with auditable evidence and measured legitimate-user friction. Token savings are a secondary comparison. [Official Remember the Attacker brief](https://www.hackerearth.com/lp/challenges/contextcon#themes)

| Official requirement or expected outcome | Implementation | Status and evidence | Remaining work |
| --- | --- | --- | --- |
| Share risk signals among distinct agents | Behaviour/Login, Device/IP, Transaction and Graph write scoped observations to the risk pack. The independent outbox worker makes them readable for later cases. | Implemented. PostgreSQL cross-session handoff and outage tests. Hosted verification in [Benchmarks](BENCHMARKS.md). | Observe handoff misses when the next event arrives before indexing. |
| Connect signals before takeover completes | Point-in-time event features, device/session transitions, bounded graph paths and the extended early rules. | Matched 1,999-event held-out PostgreSQL tape. Pre-impact alerts rose from 43 to 58 and pre-impact gates from 33 to 43. Total modeled prevention stayed at 43. | Calibrate on independent workload shapes. Measure false positives in legitimate bursts. |
| Remember earlier attacks | Confirmed-pack fingerprint learning, applicability, auditable supersession and revocation, and ordinary evidence-derived queries. Analyst-confirmed session patterns can block a repeated attack sequence on another account through the deterministic verified-pattern policy. | A/B/C/D live verified. [Ranked retrieval evaluation](BENCHMARKS.md) exercises held-out current feature snapshots. On the 1,999-event tape, the verified-pattern policy cut executed attacks from 15 to 1 and left the legitimate alert rate unchanged ([memory that changes the decision](BENCHMARKS.md#memory-that-changes-the-decision)). | Hosted Meko and agent-mode rerun. Attack variants that reorder or skip steps. |
| Explain every allow, step-up and block | Immutable decision and policy traces, rule IDs, supported specialist findings, retrieval IDs, graph paths and missing corroboration. | Implemented. Policy and fallback integration tests. | Record a concise walkthrough for submission. |
| Collective memory with relevant information promptly available | Background publication plus authenticated same-account, previous-event retrieval from a different specialist. | Implemented with cutoff at case creation. Early case needs time for inference and publication; raw local features are available sooner. | Measure latency distributions under realistic arrivals. |
| Hybrid retrieval for similar patterns | Ordinary confirmed-pack Meko ranked search built from active evidence, followed by local provenance and applicability validation. | Hosted ranked probes selected the applicable v2 on two inputs and rejected reuse on three controls. | Larger recall-at-k and distractor benchmark; the hosted ranker may omit an applicable record. |
| Knowledge base with fraud playbooks and risk rules | Six approved, versioned playbooks in `playbooks/`. They are uploaded to the confirmed pack's Meko knowledge base, selected deterministically for every alerted case, and given to the Investigator as checklist guidance. In Meko mode, `knowledgebase_search` passages bound to the approved versions are also traced and supplied. | Live verified: all six indexed `completed`, and runtime search returned verified passages with 0 unverified. Playbooks never change an action. | Agent-mode demo run with a live model. |
| Decision traces show every relevant retrieval and memory | Case traces retain ranked hits, accepted provisional handoffs, confirmed reuse and rejected fingerprints. The graph retains typed paths. | Implemented. See [Architecture](ARCHITECTURE.md) and [Graph](GRAPH.md). | Build the final presentation around the traces. |
| Separate raw-risk and confirmed-pattern datapacks | `MEKO_RISK_SIGNALS_DATAPACK_ID` and `MEKO_DATAPACK_ID` with publication-type constraints. | Hosted reads and writes to both packs are independently verified. | Keep the separation in any future workspace. |
| Up to about 2,000 synthetic events with planted attacks, and restricted memory contents | Temporal corpus with auth, reset, device/session, network, payee, transfer and multi-account scenarios. Ground truth and challenge responses stay in the evaluator. | Verified at 1,999 events. Meko receives structured risk observations and confirmed fingerprints, scoped to their intended packs. | Add more varied independent scenario families. |
| Measure early detection, lead and false positives | The replay distinguishes alert, enforced step-up, failed challenge, and actual modeled impact. | Held-out report includes alert classification, lead in seconds and episode steps, legitimate step-up and gated harm. | Repeat for additional independent and adversarial distributions. |
| At least three trace walkthroughs | A/B/C/D gives four stored traces. The early signal smoke adds separate auth and payee traces. | Three documented walkthroughs and additional CLI traces in [Benchmarks](BENCHMARKS.md). | Record the submission demo. |
| Comparison against the same agents without shared memory | Historical matched B, a small three-mode temporal evaluator with constant configured model, and `--memory compare` with an online simulated analyst. | Prior B independently verified. Memory-off and warmed memory runs on the same tape report first and repeat encounters, across four seeds, the development split, both rule profiles and a hard-negative family. Local stand-in store. | Repeat with hosted Meko and live agents. |

The organizer offers a $1,000 award for Best use of shared memory. Its announced criterion is showing agents build on one another's learning with an understandable decision trace. The public text gives no additional award-specific eligibility rules. The prototype now has a live cross-agent reuse trace suitable for demonstrating this criterion. [Official prize page](https://www.hackerearth.com/lp/challenges/contextcon#prizes)

| Criterion | Weight | Evidence now | Evidence still needed |
| --- | ---: | --- | --- |
| Use of Meko | 30% | Live isolated datapacks, confirmed and provisional publication, cross-agent reuse after process restart, and evidence-backed supersession | Playbooks, persistent analyst conversations and report artifacts. Evaluate relevant governed PostgreSQL context integration once the learning loop works. |
| Impact and usefulness | 25% | Matched held-out alert and intervention counts, false-positive tradeoff and actual Case B usage | Larger warmed-memory evaluation and an analyst workspace. |
| Technical execution | 20% | Real database features, validation, concurrent deduplication, bounded publication, traces, fallback and live A/B/C/D | More independent graph workload and recovery evaluation. |
| Innovation | 15% | Statistical behaviour signals, distinct specialists and bounded cross-account paths | Behavioural ablation and wider fingerprint-family coverage. |
| Presentation | 10% | React analyst workspace over live data: stream, review queue, case evidence, session timeline, memory patterns with matched steps, agents, graph paths, playbook checklists, and confirm, correct and revoke actions. `demo:feed` streams a synthetic tape with an optional auto-analyst. | A recorded demo under five minutes. |

Weights include the organizer's emphasis on context breadth, shared context and PostgreSQL in the Meko criterion. [Official judging criteria](https://www.hackerearth.com/lp/challenges/contextcon#judging)

## Sequence for the eventual demo

1. Show an ordinary transfer and a fast decision with zero provider calls.
2. Show a new synthetic takeover in Case A. Open the active specialists, risky relationships and rules. Verify the case and write a generalized fingerprint.
3. Replay a variant on a different account as Case B. Trace the originating agent, source case, retrieving agent and applicability checks. Show measured steps or token usage alongside the baseline.
4. Correct a false association in Case C. Replay a later legitimate variant in Case D and open the trace showing how the corrected version affected its treatment.

Steps 2–4 depend on the verified learning milestones in [the roadmap](ROADMAP.md).
