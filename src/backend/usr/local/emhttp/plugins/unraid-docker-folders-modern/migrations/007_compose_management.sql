-- Compose stack management metadata
-- Links to folders via folders.compose_project = compose_stacks.project_name
CREATE TABLE IF NOT EXISTS compose_stacks (
    project_name TEXT PRIMARY KEY,
    working_dir TEXT,
    compose_file TEXT,
    env_file TEXT,
    autostart INTEGER DEFAULT 0,
    autostart_force_recreate INTEGER DEFAULT 0,
    description TEXT,
    imported_from TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
