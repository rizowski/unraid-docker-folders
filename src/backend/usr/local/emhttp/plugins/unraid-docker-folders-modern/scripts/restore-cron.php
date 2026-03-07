#!/usr/bin/php
<?php
/**
 * Unraid Docker Folders - Restore Cron Schedule
 *
 * Called during plugin install/boot to restore the cron file from the
 * saved update_check_schedule setting. Unraid's /etc/cron.d/ is in RAM
 * and wiped on every reboot, so this must run each time the plugin loads.
 *
 * Usage: php restore-cron.php
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';

$dbPath = DB_PATH;
if (!file_exists($dbPath)) {
  // No database yet — nothing to restore
  exit(0);
}

$db = Database::getInstance();

// Check if update checks are enabled
$enabledRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'enable_update_checks'");
if (!$enabledRow || $enabledRow['value'] !== '1') {
  exit(0);
}

// Read the saved schedule
$scheduleRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_schedule'");
$schedule = $scheduleRow ? $scheduleRow['value'] : 'disabled';

CronManager::updateSchedule($schedule);

if ($schedule !== 'disabled') {
  echo "Cron schedule restored: {$schedule}";
}
