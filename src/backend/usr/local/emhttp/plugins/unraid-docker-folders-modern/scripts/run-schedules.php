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
} catch (Exception $e) {
  error_log('Schedule runner error: ' . $e->getMessage());
} finally {
  flock($fp, LOCK_UN);
  fclose($fp);
}

exit(0);
