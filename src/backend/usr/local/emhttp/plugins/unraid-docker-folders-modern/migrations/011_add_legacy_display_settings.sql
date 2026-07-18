-- Migration 011: Legacy Docker section display settings
-- When the Docker Containers section is replaced by the plugin UI, these
-- control whether the native (legacy) container list and the native action
-- buttons (Add Container, etc.) remain visible. Both hidden by default.

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('show_legacy_containers', '0', strftime('%s', 'now')),
    ('show_legacy_buttons', '0', strftime('%s', 'now'));
