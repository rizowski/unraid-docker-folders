#!/usr/bin/php
<?php

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';
require_once dirname(__DIR__) . '/classes/ScheduleManager.php';
require_once dirname(__DIR__) . '/classes/BackupManager.php';

set_time_limit(300);

// Heartbeat first, before every early exit below, so the file proves cron
// itself fired rather than proving a schedule ran. api/schedules.php reports
// its mtime, and the schedules screen warns when it goes stale.
@touch(SCHEDULER_TICK_FILE);

if (!file_exists(DOCKER_SOCKET)) {
  exit(0);
}

$lockFile = '/tmp/unraid-docker-schedules.lock';
$fp = fopen($lockFile, 'w');
if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
  exit(0);
}

try {
  $manager = new ScheduleManager();
  $results = $manager->runDueSchedules();

  if (!empty($results)) {
    WebSocketPublisher::publish('schedules', 'executed', [
      'count' => count($results),
      'results' => $results,
    ]);
  }

  // Automatic runs happen with nobody watching, so tell the user about a
  // failure. A manual "Run now" shows its result in the UI instead.
  foreach ($results as $result) {
    // A manual "Run now" of this schedule was already running, and it
    // reports its own result in the UI.
    if (($result['status'] ?? '') === 'busy') {
      continue;
    }
    // A skip succeeded at doing nothing, so it has to be tested before the
    // success check below or it would never be reported at all.
    if (($result['status'] ?? '') === 'skipped') {
      $notification = buildScheduleSkipNotification($result, $result['late_by'] ?? 0);
      sendUnraidNotification($notification['subject'], $notification['description'], 'normal');
      error_log('Schedule skipped: ' . $notification['subject'] . ' (' . $notification['description'] . ')');
      continue;
    }
    if (!empty($result['success'])) {
      continue;
    }
    $notification = buildScheduleFailureNotification($result, $result['message'] ?? '');
    sendUnraidNotification($notification['subject'], $notification['description'], 'warning');
    error_log('Schedule failed: ' . $notification['subject'] . ' (' . $notification['description'] . ')');
  }
} catch (Exception $e) {
  error_log('Schedule runner error: ' . $e->getMessage());
  sendUnraidNotification('Schedule runner failed', $e->getMessage(), 'warning');
} finally {
  flock($fp, LOCK_UN);
  fclose($fp);
}

exit(0);
