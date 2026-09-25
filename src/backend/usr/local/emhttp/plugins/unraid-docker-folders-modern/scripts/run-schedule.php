#!/usr/bin/php
<?php
/**
 * Unraid Docker Folders - run one schedule in its own process
 *
 * Usage: php run-schedule.php <schedule id>
 *
 * dfmLaunchScheduleRun() starts this, detached, for an update schedule, from
 * the minute runner and from "Run now". A pull can take minutes, and the
 * runner's lock, or a web request, must not wait for it. The per-schedule
 * lock in executeSchedule() keeps two runs of one schedule apart.
 *
 * @package UnraidDockerModern
 */

if (PHP_SAPI !== 'cli') {
  exit(1);
}

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';
require_once dirname(__DIR__) . '/classes/ScheduleManager.php';

set_time_limit(0);

$id = (int) ($argv[1] ?? 0);
if ($id <= 0) {
  fwrite(STDERR, "Usage: run-schedule.php <schedule id>\n");
  exit(1);
}

try {
  $result = (new ScheduleManager())->executeSchedule($id);
  WebSocketPublisher::publish('schedules', 'executed', ['id' => $id, 'results' => [$result]]);
  notifyScheduleResult($result);
} catch (Throwable $e) {
  error_log('Schedule run error: ' . $e->getMessage());
  sendUnraidNotification('Schedule run failed', $e->getMessage(), 'warning');
  exit(1);
}

exit(0);
