-- Approved fraud playbooks. Files under playbooks/ are the source; each id and version is
-- immutable once loaded. kb_* columns track the copy in the Meko knowledge base.
CREATE TABLE playbooks (
    id text NOT NULL CHECK (id ~ '^pb-[a-z0-9-]{1,60}$'),
    version integer NOT NULL CHECK (version > 0),
    title text NOT NULL,
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    body text NOT NULL,
    triggers jsonb NOT NULL,
    checklist jsonb NOT NULL,
    loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    kb_state text NOT NULL DEFAULT 'local'
        CHECK (kb_state IN ('local', 'awaiting_upload', 'indexing', 'completed', 'failed', 'abandoned', 'oversized')),
    kb_document_key text,
    kb_checked_at timestamptz,
    kb_error text,
    PRIMARY KEY (id, version)
);
