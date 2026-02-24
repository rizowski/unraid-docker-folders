<?php
/**
 * Unraid Docker Folders - Cron Schedule Manager
 *
 * Writes/removes /etc/cron.d/unraid-docker-folders-modern based on the
 * update_check_schedule setting.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';

class CronManager
{
  const CRON_FILE = '/etc/cron.d/unraid-docker-folders-modern';
  const SCRIPT_PATH = PLUGIN_DIR . '/scripts/check-updates.php';

  /**
   * Schedule options mapped to cron expressions.
   */
  private static $schedules = [
    'hourly'      => '0 * * * *',
    'daily'       => '0 3 * * *',
    'twice_daily' => '0 3,15 * * *',
    'weekly'      => '0 3 * * 0',
  ];

  /**
   * Update (or remove) the cron file based on the given schedule value.
   *
   * @param string $schedule  One of: disabled, hourly, daily, twice_daily, weekly
   */
  public static function updateSchedule($schedule)
  {
    if ($schedule === 'disabled' || !isset(self::$schedules[$schedule])) {
      self::removeSchedule();
      return;
    }

    $cronExpr = self::$schedules[$schedule];
    $scriptPath = self::SCRIPT_PATH;

    $content = "# Docker Folders Modern - automatic update checks\n";
    $content .= "{$cronExpr} root /usr/bin/php {$scriptPath} > /dev/null 2>&1\n";

    file_put_contents(self::CRON_FILE, $content);
    chmod(self::CRON_FILE, 0644);
  }

  /**
   * Remove the cron file if it exists.
   */
  public static function removeSchedule()
  {
    if (file_exists(self::CRON_FILE)) {
      unlink(self::CRON_FILE);
    }
  }
}
