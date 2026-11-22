# Data model

| Relation | Purpose |
| --- | --- |
| `events` | One validated event per UUID. Typed columns support history queries. The canonical JSON payload supports equality on retries. |
| `cases` | One investigation or decision per event, with action, timestamps, lease state, and a JSON audit snapshot. |
| `analyst_feedback` | One analyst decision per case, and the publication it created or corroborated (`publication_id`, migration 007). |
| `memory_publications` | Outbox and local verified mirror of both Meko datapacks: document, delivery state, remote ID, supersession and revocation. |
| `playbooks` | Approved playbook versions (migration 008): title, checksum, body, triggers, checklist, and the Meko knowledge-base upload state. An id and version are immutable once loaded. |
| `schema_migrations` | Migration names, SHA-256 checksums and application times. |

Events identify synthetic accounts, devices and networks, with optional payees for registrations or transfers. Amounts use minor units of one simulated currency. Timing observations are numeric dwell, flight and interaction intervals. No typed text is captured.

The simulator keeps labels keyed by event ID in its own process. The schema rejects labels, and app feature queries and model payloads never read them.

History indexes cover account, device, network and account/payee time lookups. Feature windows cut off strictly before the current event's event-time. Events arriving out of order can only contribute to later snapshots if already persisted. An earlier decision retains its original snapshot. Count and foreign-key constraints enforce event and case identity.

Ingestion runs in a short transaction that serializes same-account insertions through an advisory lock. Concurrent cross-account events may observe different committed histories. Replay chronologically for comparable experiments. Pending leases and final decisions use database time. Replaying a decided case returns its original trace, including the features and policy thresholds used at decision time.

Confirmed fingerprint documents (`contextcon-learning-v1`) may carry `pattern` (`transfer_signature` or `session_sequence`), ordered `steps` of event kind and rule IDs, and analyst `conditions`. Documents written before these fields existed are transfer signatures and remain readable. Migration numbers skip 004. The runner applies files in name order and needs no contiguous numbering.
