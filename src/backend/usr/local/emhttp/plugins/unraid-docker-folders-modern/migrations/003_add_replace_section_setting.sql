-- Migration 003: Add replace_docker_section setting
-- When enabled, the plugin replaces the Docker Containers section content
-- with the modern folders UI

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('replace_docker_section', '0', strftime('%s', 'now'));
