-- Migration 003: Add replace_docker_section setting
-- When enabled, the plugin replaces the Docker Containers section content
-- with the modern folders UI.
--
-- New installs start with it on, because the Folders UI works better without
-- the native section beside it. Migrations are tracked by filename, so an
-- existing install never runs this again and keeps the value it has.

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('replace_docker_section', '1', strftime('%s', 'now'));
