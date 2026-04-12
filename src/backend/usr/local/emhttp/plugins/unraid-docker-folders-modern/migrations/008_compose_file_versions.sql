-- Compose file version history
-- Stores references to version files on disk for rollback support
CREATE TABLE IF NOT EXISTS compose_file_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK(file_type IN ('compose', 'env')),
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (project_name) REFERENCES compose_stacks(project_name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compose_versions_project
    ON compose_file_versions(project_name, file_type, created_at DESC);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('compose_max_versions', '10', strftime('%s', 'now'));
