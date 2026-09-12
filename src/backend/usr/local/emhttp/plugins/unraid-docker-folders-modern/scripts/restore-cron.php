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
require_once dirname(__DIR__) . '/classes/ScheduleManager.php';

$dbPath = DB_PATH;
if (!file_exists($dbPath)) {
  // No database yet — nothing to restore
  exit(0);
}

$db = Database::getInstance();

// Recompute next_run_at for enabled schedules — the server timezone may
// differ across an install/boot (e.g. after config.php started resolving it
// from ident.cfg instead of always using UTC), which would otherwise leave
// stale next_run_at values around until each schedule fires or is edited.
// Deliberately unconditional and ahead of the update-checks guard below:
// container/stack schedules have nothing to do with image update checks, and
// gating this on that setting would mean it never runs for most installs.
// Failure here must not break cron restore itself.
try {
  $scheduleManager = new ScheduleManager();
  $recomputed = $scheduleManager->recomputeAllNextRuns();
  echo "Recomputed next run for {$recomputed} schedule(s)\n";
} catch (Exception $e) {
  error_log('restore-cron: failed to recompute next_run_at: ' . $e->getMessage());
}

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
  echo "Cron schedule restored: {$schedule}\n";
}

// Restore scheduler cron if any enabled schedules exist
CronManager::ensureSchedulerCron($db);
echo "Schedule runner cron checked\n";
