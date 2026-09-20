-- Migration 017: Security findings the user accepted on purpose.
-- Keyed by container_name because ids change on recreate, and by finding_type
-- so dismissing one finding does not silence the next one on the same
-- container. Rows are not pruned when a container is renamed or removed: the
-- only cleanup path would be the container-list GET, which already mutates
-- more than it should, and a stale row is two short strings.
CREATE TABLE IF NOT EXISTS security_dismissals (
    container_name TEXT NOT NULL,
    finding_type   TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (container_name, finding_type)
);
