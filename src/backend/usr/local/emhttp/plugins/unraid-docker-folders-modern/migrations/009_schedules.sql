-- Schedules: recurring actions for containers and compose stacks
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('container', 'stack')),
    target_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('start', 'stop', 'pause', 'restart', 'backup')),
    cron_expression TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    backup_config TEXT,
    last_run_at INTEGER,
    last_run_status TEXT CHECK(last_run_status IN ('success', 'error', 'skipped')),
    last_run_message TEXT,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_target ON schedules(target_type, target_id);

-- Execution history
CREATE TABLE IF NOT EXISTS schedule_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error', 'skipped')),
    message TEXT,
    backup_file TEXT,
    backup_size INTEGER,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedule_history_schedule ON schedule_history(schedule_id, started_at);

-- Default settings for backups
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('backup_destination', '/mnt/user/backups/docker-folders', strftime('%s', 'now')),
    ('default_retention_count', '7', strftime('%s', 'now'));
