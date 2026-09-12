-- Migration 013: manual order for containers that are in no folder.
-- Keyed by container_name to match container_folders (ids change on recreate).
-- A name with no row sorts into the tail with the state-first default.
CREATE TABLE IF NOT EXISTS unfoldered_order (
    container_name TEXT PRIMARY KEY,
    position INTEGER NOT NULL
);
