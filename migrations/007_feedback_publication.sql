-- The publication an analyst decision created or corroborated. Older rows stay NULL and
-- resolve through memory_publications.case_id as before.
ALTER TABLE analyst_feedback ADD COLUMN publication_id uuid REFERENCES memory_publications(id);
