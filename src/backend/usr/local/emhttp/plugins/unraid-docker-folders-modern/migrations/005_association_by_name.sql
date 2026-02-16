-- Migration 005: Switch container_folders unique constraint from container_id to container_name
-- Container IDs change when containers are recreated/updated; names are stable.

-- SQLite doesn't support DROP CONSTRAINT, so recreate the table.

-- 1. Create new table with UNIQUE on container_name instead of container_id
CREATE TABLE IF NOT EXISTS container_folders_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id TEXT NOT NULL,
    container_name TEXT NOT NULL,
    folder_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
    UNIQUE(container_name)
);

-- 2. Copy data, keeping only the latest row per container_name
INSERT OR IGNORE INTO container_folders_new (container_id, container_name, folder_id, position)
    SELECT container_id, container_name, folder_id, position
    FROM container_folders
    ORDER BY id ASC;

-- 3. Drop old table and rename
DROP TABLE IF EXISTS container_folders;
ALTER TABLE container_folders_new RENAME TO container_folders;

-- 4. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_container_folders_folder
    ON container_folders(folder_id);

CREATE INDEX IF NOT EXISTS idx_container_folders_name
    ON container_folders(container_name);
