-- Migration 004: Add show_folder_ports setting
-- When enabled, collapsed folders show the public ports of their containers

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('show_folder_ports', '1', strftime('%s', 'now'));
