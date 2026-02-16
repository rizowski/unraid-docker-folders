CREATE TABLE IF NOT EXISTS image_update_checks (
    image TEXT PRIMARY KEY,
    local_digest TEXT,
    remote_digest TEXT,
    update_available BOOLEAN DEFAULT 0,
    checked_at INTEGER NOT NULL,
    error TEXT
);
