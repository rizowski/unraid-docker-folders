-- Migration 016: Compose containers the user took out of their stack folder.
-- syncComposeStacks puts every unassigned Compose container into its stack
-- folder on each container list load. A name in this table is skipped, so a
-- container the user removed stays out. Keyed by container_name because ids
-- change on recreate.
CREATE TABLE IF NOT EXISTS compose_sync_exclusions (
    container_name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);
