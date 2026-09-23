<?php
/**
 * Unraid Docker Folders - GraphQL backend watchdog
 *
 * Switches backend_mode back to PHP when the GraphQL backend stops working,
 * for example after an Unraid API update. run-schedules.php calls run() once
 * a minute from cron.
 *
 * The trigger is the plugin runner's heartbeat file (DFM_RUNNER_ALIVE_FILE),
 * not a GraphQL probe, because a probe from cron has no session and logs two
 * authentication errors in the API log each time. The probe runs only after
 * the heartbeat has been stale for STALE_GRACE seconds, to find out why.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';

class BackendWatchdog
{
  /** The heartbeat must be stale this long before the watchdog acts. */
  const STALE_GRACE = 300;
  /** After an install, the first heartbeat can take a minute or more. */
  const INSTALL_GRACE = 300;
  /** When the heartbeat first went stale. In RAM, so a reboot starts over. */
  const STALE_SINCE_FILE = '/var/run/' . PLUGIN_NAME . '.backend-stale';

  const NONE = 'none';
  const WAIT = 'wait';
  const ROLLBACK = 'rollback';
  const ROLLBACK_AND_REMOVE = 'rollback-and-remove';

  /**
   * Pure decision. Inputs:
   *   mode          'php' | 'graphql' | null (unreadable)
   *   heartbeatAge  seconds since the plugin runner's heartbeat, null if none
   *   sinceInstall  seconds since api-plugin.sh last installed, null if unknown
   *   staleFor      seconds the heartbeat has been stale
   *   apiRunning    the Unraid API process reports online (null: not checked)
   *   probe         dfmGraphqlPluginState() (null: not checked)
   *   installed     the backend package is in the API's node_modules
   *   marker        an earlier rollback left DFM_BACKEND_ROLLBACK_MARKER
   */
  public static function decide(array $in)
  {
    if (($in['mode'] ?? null) !== 'graphql') {
      return self::NONE;
    }
    $age = $in['heartbeatAge'] ?? null;
    if ($age !== null && $age <= DFM_RUNNER_ALIVE_STALE_SECONDS) {
      return self::NONE;
    }
    $sinceInstall = $in['sinceInstall'] ?? null;
    if ($sinceInstall !== null && $sinceInstall < self::INSTALL_GRACE) {
      return self::NONE;
    }
    if (($in['staleFor'] ?? 0) < self::STALE_GRACE) {
      return self::WAIT;
    }
    // A stopped API is not ours to fix. PHP already runs schedules once the
    // heartbeat is stale, and the frontend falls back to PHP on its own.
    if (empty($in['apiRunning'])) {
      return self::NONE;
    }
    $probe = $in['probe'] ?? null;
    if ($probe === 'load-failed' || $probe === 'not-installed') {
      return self::ROLLBACK;
    }
    // The API runs but its GraphQL service does not answer. Our backend can
    // be the cause, so take it out, once.
    if ($probe === 'offline' || $probe === 'no-api') {
      return (!empty($in['installed']) && empty($in['marker'])) ? self::ROLLBACK_AND_REMOVE : self::ROLLBACK;
    }
    // The field answers, so the pages work. Only the runner is quiet, and
    // PHP already covers its work while the heartbeat is stale.
    return self::NONE;
  }

  /**
   * Gather the inputs, decide, and act unless $dryRun.
   *
   * @return array{decision: string, inputs: array}
   */
  public static function run($dryRun = false)
  {
    $now = time();
    $in = ['mode' => dfmReadBackendMode()];

    clearstatcache(true, DFM_RUNNER_ALIVE_FILE);
    $alive = @filemtime(DFM_RUNNER_ALIVE_FILE);
    $in['heartbeatAge'] = $alive === false ? null : $now - $alive;

    $state = dfmReadJsonFile(DFM_API_PLUGIN_STATE_FILE);
    if (is_array($state) && in_array($state['state'] ?? '', ['installing', 'removing'], true)) {
      $in['sinceInstall'] = 0;
    } elseif (is_array($state) && in_array($state['state'] ?? '', ['ready', 'installed'], true)) {
      $in['sinceInstall'] = $now - (int) ($state['at'] ?? 0);
    } else {
      $in['sinceInstall'] = null;
    }

    $staleSince = (int) @file_get_contents(self::STALE_SINCE_FILE);
    $stale = $in['mode'] === 'graphql'
      && ($in['heartbeatAge'] === null || $in['heartbeatAge'] > DFM_RUNNER_ALIVE_STALE_SECONDS);
    if (!$stale) {
      if ($staleSince && !$dryRun) {
        @unlink(self::STALE_SINCE_FILE);
      }
      $staleSince = 0;
    } elseif (!$staleSince) {
      $staleSince = $now;
      if (!$dryRun) {
        @file_put_contents(self::STALE_SINCE_FILE, (string) $now);
      }
    }
    $in['staleFor'] = $stale ? $now - $staleSince : 0;

    // The costly checks run only when the answer depends on them.
    if ($stale && $in['staleFor'] >= self::STALE_GRACE) {
      $in['apiRunning'] = self::apiRunning();
      $in['probe'] = $in['apiRunning'] ? dfmGraphqlPluginState() : null;
      $in['installed'] = dfmGraphqlPluginInstalled();
      $in['marker'] = is_file(DFM_BACKEND_ROLLBACK_MARKER);
    }

    $decision = self::decide($in);
    if (!$dryRun && ($decision === self::ROLLBACK || $decision === self::ROLLBACK_AND_REMOVE)) {
      self::rollBack($decision, $in);
    }
    return ['decision' => $decision, 'inputs' => $in];
  }

  private static function apiRunning()
  {
    $out = [];
    exec('timeout 15 unraid-api status 2>/dev/null', $out);
    return stripos(implode("\n", $out), 'online') !== false;
  }

  private static function rollBack($decision, array $in)
  {
    require_once PLUGIN_DIR . '/classes/Database.php';
    require_once PLUGIN_DIR . '/classes/CronManager.php';
    $db = Database::getInstance();
    // Only from graphql, so a user who switched in the meantime keeps theirs.
    $db->query(
      'UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?',
      ['php', time(), 'backend_mode', 'graphql']
    );
    CronManager::ensureSchedulerCron($db);

    $reason = [
      'load-failed' => 'The Unraid API did not load the GraphQL backend.',
      'not-installed' => 'The GraphQL backend is no longer installed in the Unraid API.',
      'offline' => 'The Unraid API is running, but its GraphQL service does not answer.',
      'no-api' => 'The Unraid API is running, but its GraphQL service does not answer.',
    ][$in['probe'] ?? ''] ?? 'The GraphQL backend stopped answering.';
    $removed = $decision === self::ROLLBACK_AND_REMOVE;

    @file_put_contents(DFM_BACKEND_ROLLBACK_MARKER, json_encode([
      'at' => time(),
      'reason' => $reason,
      'removed' => $removed,
    ]) . "\n");
    @unlink(self::STALE_SINCE_FILE);

    $description = $reason . ' Docker Folders switched back to the PHP backend.'
      . ($removed ? ' It also removed the GraphQL backend and restarted the Unraid API.' : '');
    error_log('Docker Folders backend watchdog: ' . $description);
    sendUnraidNotification('Switched back to the PHP backend', $description, 'warning');

    if ($removed) {
      dfmLaunchApiPlugin('remove');
    }
  }
}
