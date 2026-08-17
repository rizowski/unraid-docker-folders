-- Cached "latest release" notes, shown in the update confirm modal.
--
-- Keyed by GitHub repo rather than image: one repo backs many image tags, and
-- checkAllImageUpdates() DELETEs stale image_update_checks rows, which would
-- evaporate image-keyed notes every time a container recreation changes the
-- image reference. Repo keying also makes per-run request dedupe fall out of
-- the primary key for free.
ALTER TABLE image_update_checks ADD COLUMN source_repo TEXT;

CREATE TABLE IF NOT EXISTS release_notes (
    repo TEXT PRIMARY KEY,
    tag TEXT,
    name TEXT,
    published_at INTEGER,
    url TEXT,
    summary TEXT,
    etag TEXT,
    status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok', 'not_found', 'error')),
    fetched_at INTEGER NOT NULL
);
