#!/usr/bin/php
<?php
/**
 * Unraid Docker Folders - Restore Cron Schedule
 *
 * Called during plugin install/boot. Recomputes schedule next-run times for
 * the current server timezone, restores the schedule runner cron, and
 * restores the update-check cron from the saved setting. Unraid's
 * /etc/cron.d/ is in RAM and wiped on every reboot, so this must run each
 * time the plugin loads.
 *
 * Usage: php restore-cron.php
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';
require_once dirname(__DIR__) . '/classes/ScheduleManager.php';

$dbPath = DB_PATH;
if (!file_exists($dbPath)) {
  // No database yet — nothing to restore
  exit(0);
}

$db = Database::getInstance();

// Container/stack schedules have nothing to do with image update checks, so
// both steps below run regardless of that setting. A failure here must not
// break the rest of the restore.
try {
  $recomputed = (new ScheduleManager())->recomputeAllNextRuns();
  echo "Recomputed next run for {$recomputed} schedule(s)
";
} catch (Exception $e) {
  error_log('restore-cron: failed to recompute next_run_at: ' . $e->getMessage());
}

CronManager::ensureSchedulerCron($db);
echo "Schedule runner cron checked
";

// The image update-check cron line is only restored when that feature is on.
$enabledRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'enable_update_checks'");
if ($enabledRow && $enabledRow['value'] === '1') {
  $scheduleRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_schedule'");
  $schedule = $scheduleRow ? $scheduleRow['value'] : 'disabled';
  CronManager::updateSchedule($schedule);
  if ($schedule !== 'disabled') {
    echo "Cron schedule restored: {$schedule}
";
  }
}
