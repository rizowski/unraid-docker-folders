<?php

require_once dirname(__DIR__) . '/include/config.php';

class CronManager
{
  const CRON_FILE = '/etc/cron.d/unraid-docker-folders-modern';
  const UPDATE_SCRIPT = PLUGIN_DIR . '/scripts/check-updates.php';
  const SCHEDULER_SCRIPT = PLUGIN_DIR . '/scripts/run-schedules.php';

  private static $schedules = [
    'hourly'      => '0 * * * *',
    'daily'       => '0 3 * * *',
    'twice_daily' => '0 3,15 * * *',
    'weekly'      => '0 3 * * 0',
  ];

  public static function updateSchedule($schedule)
  {
    if ($schedule === 'disabled' || !isset(self::$schedules[$schedule])) {
      self::removeLine('update-checks');
    } else {
      self::setLine('update-checks', self::$schedules[$schedule], self::UPDATE_SCRIPT);
    }
  }

  public static function removeSchedule()
  {
    self::removeLine('update-checks');
  }

  public static function ensureSchedulerCron($db = null)
  {
    if ($db === null) {
      require_once dirname(__DIR__) . '/classes/Database.php';
      $db = Database::getInstance();
    }

    $count = $db->fetchValue('SELECT COUNT(*) FROM schedules WHERE enabled = 1');

    if ($count > 0) {
      self::setLine('schedule-runner', '* * * * *', self::SCHEDULER_SCRIPT);
    } else {
      self::removeLine('schedule-runner');
    }
  }

  public static function removeSchedulerCron()
  {
    self::removeLine('schedule-runner');
  }

  private static function setLine($tag, $cronExpr, $scriptPath)
  {
    $lines = self::readLines();
    $entry = "{$cronExpr} root /usr/bin/php {$scriptPath} > /dev/null 2>&1";
    $marker = "# docker-folders-modern:{$tag}";

    $found = false;
    foreach ($lines as $i => $line) {
      if (strpos($line, "docker-folders-modern:{$tag}") !== false) {
        $lines[$i] = $marker;
        if (isset($lines[$i + 1])) {
          $lines[$i + 1] = $entry;
        } else {
          $lines[] = $entry;
        }
        $found = true;
        break;
      }
    }

    if (!$found) {
      $lines[] = $marker;
      $lines[] = $entry;
    }

    self::writeLines($lines);
  }

  private static function removeLine($tag)
  {
    $lines = self::readLines();
    $filtered = [];
    $skipNext = false;

    foreach ($lines as $line) {
      if (strpos($line, "docker-folders-modern:{$tag}") !== false) {
        $skipNext = true;
        continue;
      }
      if ($skipNext) {
        $skipNext = false;
        continue;
      }
      $filtered[] = $line;
    }

    if (empty(array_filter($filtered, function ($l) { return trim($l) !== ''; }))) {
      if (file_exists(self::CRON_FILE)) {
        unlink(self::CRON_FILE);
      }
      return;
    }

    self::writeLines($filtered);
  }

  private static function readLines()
  {
    if (!file_exists(self::CRON_FILE)) {
      return [];
    }
    $content = file_get_contents(self::CRON_FILE);
    return $content ? explode("\n", rtrim($content, "\n")) : [];
  }

  private static function writeLines($lines)
  {
    $content = implode("\n", $lines) . "\n";
    file_put_contents(self::CRON_FILE, $content);
    chmod(self::CRON_FILE, 0644);
  }
}
