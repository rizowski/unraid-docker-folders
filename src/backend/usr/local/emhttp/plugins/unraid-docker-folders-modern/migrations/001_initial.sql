-- Unraid Docker Folders - Initial Database Schema
-- Migration 001: Create core tables for folder management

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    position INTEGER DEFAULT 0,
    collapsed BOOLEAN DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Container-folder associations
CREATE TABLE IF NOT EXISTS container_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id TEXT NOT NULL,
    container_name TEXT NOT NULL,
    folder_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    UNIQUE(container_id)
);

-- Plugin settings
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
);

-- Container metadata cache (for performance)
CREATE TABLE IF NOT EXISTS container_cache (
    container_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    status TEXT,
    state TEXT,
    data TEXT,
    updated_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_container_folders_folder
    ON container_folders(folder_id);

CREATE INDEX IF NOT EXISTS idx_container_folders_container
    ON container_folders(container_id);

CREATE INDEX IF NOT EXISTS idx_folders_position
    ON folders(position);

CREATE INDEX IF NOT EXISTS idx_container_cache_status
    ON container_cache(status);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('version', '1.0.0', strftime('%s', 'now')),
    ('default_view', 'folders', strftime('%s', 'now')),
    ('auto_collapse', '0', strftime('%s', 'now')),
    ('show_stats', '0', strftime('%s', 'now')),
    ('theme', 'auto', strftime('%s', 'now'));
