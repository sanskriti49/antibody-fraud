# Design decisions

## Choose one local data store

PostgreSQL lets a case claim, event insertion, history read and fast decision share a transaction. A separate queue or graph store would add operational dependencies before either workload is measured. Current tests exercise real PostgreSQL, parallel duplicates and crash recovery fences. Multi-hop graph traversal uses bounded relational queries ([Graph](GRAPH.md)).

## Keep numerical scoring and action policy deterministic

A model can explain timing evidence, while SQL and TypeScript calculate evidence and enforce the simulated action. This protects the fast path and makes threshold failures reproducible. The trade-off is that agent recommendations cannot improve decision quality directly. Tests cover allowable travel, suspicious activity, impossible travel, policy enforcement and missing dependencies.

## Let only verified memory change an action, and only deterministically

Memory that never changes a decision can save work but cannot stop an attacker who passes a step-up challenge. The verified-pattern policy lets an analyst-confirmed session pattern block a later session on another account that repeats its opening steps in order. Three choices keep this safe. Provisional risk observations never qualify, because something suspicious is not necessarily something fraudulent. Matching is an exact rule-subset comparison over ordered steps, with no model and no similarity score. The evaluation showed that fuzzy overlap would have blocked legitimate bursts. And every block records the publication and origin case, so an analyst can correct the pattern with a condition or revoke it. The policy reads the local verified mirror of the confirmed datapack, so the fast path makes no network call. It is off by default and has a shadow mode. See [Decision flow](DECISION_FLOW.md#verified-pattern-policy).

## Write to Meko only through a verified outbox

The first integration was read-only `memory_search`. Write-back now goes through a PostgreSQL outbox. A worker writes each document once and verifies it by exact remote ID before marking it published. Only published records can be reused or drive the verified-pattern policy. Retrieved prose stays out of model inputs, and records pass version, provenance and applicability checks.

## Keep provider calls outside PostgreSQL transactions

The app persists a pending case and its feature snapshot before calling a provider. A lease and commit-time token check prevent stale investigators from updating a decided case. Identical event replay can recover a timed-out lease. This still permits the remote calls of an interrupted attempt to be repeated, which is acceptable for bounded read and inference calls. Meko writes never run inside this path. They go through the outbox and reconciliation worker described above.
