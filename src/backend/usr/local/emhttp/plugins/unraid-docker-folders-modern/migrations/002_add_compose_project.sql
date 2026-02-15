-- Migration 002: Add compose_project column for auto-grouping Docker Compose stacks
-- NULL = manually created folder, non-NULL = auto-created from compose project name

ALTER TABLE folders ADD COLUMN compose_project TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_folders_compose_project ON folders(compose_project);
