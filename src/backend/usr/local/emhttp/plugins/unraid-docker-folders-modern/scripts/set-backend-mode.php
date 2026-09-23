#!/usr/bin/php
<?php
/**
 * Set backend_mode from the shell: php set-backend-mode.php <php|graphql>
 *
 * scripts/api-plugin.sh calls it, after the GraphQL backend answers or for a
 * manual rollback, so the mode is written the same way settings.php writes it.
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';

$mode = $argv[1] ?? '';
if (!in_array($mode, BACKEND_MODES, true)) {
  fwrite(STDERR, 'usage: set-backend-mode.php <' . implode('|', BACKEND_MODES) . ">\n");
  exit(2);
}

try {
  dfmWriteBackendMode(Database::getInstance(), $mode);
  echo "backend_mode set to {$mode}\n";
} catch (Throwable $e) {
  fwrite(STDERR, 'Could not set backend_mode: ' . $e->getMessage() . "\n");
  exit(1);
}
