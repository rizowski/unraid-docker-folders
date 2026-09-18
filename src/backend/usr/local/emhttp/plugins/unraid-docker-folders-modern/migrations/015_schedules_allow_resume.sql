-- Allow the 'resume' schedule action (issue #7).
--
-- 009 limited schedules.action with a CHECK constraint that predates 'resume',
-- so creating or editing a Resume schedule failed the INSERT/UPDATE with a 500.
-- SQLite cannot alter a CHECK, so both schedule tables are rebuilt.
--
-- Copies are taken before anything is dropped: migrations run inside a
-- transaction with foreign_keys = ON (the PRAGMA cannot be turned off there),
-- and dropping schedules would cascade-delete schedule_history. ALTER TABLE
-- RENAME is avoided because it rewrites the child table's foreign key to
-- point at the renamed table.

CREATE TABLE _schedules_copy AS SELECT * FROM schedules;
CREATE TABLE _schedule_history_copy AS SELECT * FROM schedule_history;

DROP TABLE schedule_history;
DROP TABLE schedules;

CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK(target_type IN ('container', 'stack')),
    target_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('start', 'stop', 'pause', 'resume', 'restart', 'backup')),
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

CREATE TABLE schedule_history (
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

INSERT INTO schedules (
    id, name, target_type, target_id, action, cron_expression, enabled, backup_config,
    last_run_at, last_run_status, last_run_message, next_run_at, created_at, updated_at
)
SELECT
    id, name, target_type, target_id, action, cron_expression, enabled, backup_config,
    last_run_at, last_run_status, last_run_message, next_run_at, created_at, updated_at
FROM _schedules_copy;

INSERT INTO schedule_history (
    id, schedule_id, started_at, finished_at, status, message, backup_file, backup_size
)
SELECT
    id, schedule_id, started_at, finished_at, status, message, backup_file, backup_size
FROM _schedule_history_copy;

DROP TABLE _schedule_history_copy;
DROP TABLE _schedules_copy;
