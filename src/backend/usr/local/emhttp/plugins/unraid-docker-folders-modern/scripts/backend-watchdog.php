#!/usr/bin/php
<?php
/**
 * Run the GraphQL backend watchdog by hand: php backend-watchdog.php [--dry-run]
 *
 * run-schedules.php runs it every minute. --dry-run prints the inputs and the
 * decision and changes nothing.
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/BackendWatchdog.php';

$dryRun = in_array('--dry-run', $argv, true);
$result = BackendWatchdog::run($dryRun);
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
