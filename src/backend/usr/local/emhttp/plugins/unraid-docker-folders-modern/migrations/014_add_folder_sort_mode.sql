-- Migration 014: Add per-folder sort_mode column
-- Controls how each folder's own containers are ordered for display.
-- 'manual' preserves the drag & drop order stored in container_folders.position.
-- Values: manual | name-asc | name-desc | status | created-asc | created-desc

ALTER TABLE folders ADD COLUMN sort_mode TEXT NOT NULL DEFAULT 'manual';
