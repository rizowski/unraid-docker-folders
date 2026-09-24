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
  /** An install or removal older than this is stuck, not running. */
  const STUCK_RUN = 900;
  /** After a check finds nothing to do, the next one waits this long. */
  const CHECK_INTERVAL = 300;
  /**
   * {since, checked}: when the heartbeat went stale, and when the costly
   * checks last ran. In RAM, so a reboot starts over.
   */
  const STALE_SINCE_FILE = '/var/run/' . PLUGIN_NAME . '.backend-stale';
  /** Cron runs jobs with PATH=/bin:/sbin:/usr/bin:/usr/sbin. */
  const PATH_ENV = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

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
   *   apiUptime     seconds since that process started (null: unknown)
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
    // The heartbeat was stale while the API was down. A freshly started API
    // gets the same grace before its answers count, because it answers
    // "offline", or has no socket at all, while it starts.
    $uptime = $in['apiUptime'] ?? null;
    if ($uptime !== null && $uptime < self::STALE_GRACE) {
      return self::WAIT;
    }
    $probe = $in['probe'] ?? null;
    if ($probe === 'ready') {
      // The field answers, so the pages work. Only the runner is quiet, and
      // PHP already covers its work while the heartbeat is stale.
      return self::NONE;
    }
    if ($probe === 'load-failed' || $probe === 'not-installed') {
      return self::ROLLBACK;
    }
    // The API runs but its GraphQL service does not answer. Our backend can
    // be the cause, so take it out, once.
    if ($probe === 'offline' || $probe === 'no-api') {
      return (!empty($in['installed']) && empty($in['marker'])) ? self::ROLLBACK_AND_REMOVE : self::ROLLBACK;
    }
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

    // A run still in progress holds the grace, but only while it is recent:
    // a script killed mid-run leaves "installing" behind for good.
    $state = dfmReadJsonFile(DFM_API_PLUGIN_STATE_FILE);
    $stateAge = is_array($state) ? $now - (int) ($state['at'] ?? 0) : null;
    if ($stateAge !== null && in_array($state['state'] ?? '', ['installing', 'removing'], true)) {
      $in['sinceInstall'] = $stateAge < self::STUCK_RUN ? 0 : $stateAge;
    } elseif ($stateAge !== null && in_array($state['state'] ?? '', ['ready', 'installed'], true)) {
      $in['sinceInstall'] = $stateAge;
    } else {
      $in['sinceInstall'] = null;
    }

    $tracked = dfmReadJsonFile(self::STALE_SINCE_FILE) ?? [];
    $staleSince = (int) ($tracked['since'] ?? 0);
    $checked = (int) ($tracked['checked'] ?? 0);
    $stale = $in['mode'] === 'graphql'
      && ($in['heartbeatAge'] === null || $in['heartbeatAge'] > DFM_RUNNER_ALIVE_STALE_SECONDS);
    if (!$stale) {
      if ($tracked && !$dryRun) {
        @unlink(self::STALE_SINCE_FILE);
      }
      $staleSince = 0;
    } elseif (!$staleSince) {
      $staleSince = $now;
      $checked = 0;
      if (!$dryRun) {
        self::track($staleSince, $checked);
      }
    }
    $in['staleFor'] = $stale ? $now - $staleSince : 0;

    // The costly checks run only when the answer depends on them, and at
    // most once per CHECK_INTERVAL while nothing needs doing.
    if ($stale && $in['staleFor'] >= self::STALE_GRACE) {
      if (!$dryRun && $checked && $now - $checked < self::CHECK_INTERVAL) {
        return ['decision' => self::WAIT, 'inputs' => $in + ['nextCheckIn' => self::CHECK_INTERVAL - ($now - $checked)]];
      }
      // The probe first: it is a short curl call, and "ready" settles it.
      $in['probe'] = dfmGraphqlPluginState();
      if ($in['probe'] === 'ready') {
        $in['apiRunning'] = true;
      } else {
        $api = self::apiProcess();
        $in['apiRunning'] = $api['running'];
        $in['apiUptime'] = $api['uptime'];
      }
      $in['installed'] = dfmGraphqlPluginInstalled();
      $in['marker'] = is_file(DFM_BACKEND_ROLLBACK_MARKER);
      if (!$dryRun) {
        self::track($staleSince, $now);
      }
    }

    $decision = self::decide($in);
    if (!$dryRun && ($decision === self::ROLLBACK || $decision === self::ROLLBACK_AND_REMOVE)) {
      self::rollBack($decision, $in);
    }
    return ['decision' => $decision, 'inputs' => $in];
  }

  private static function track($since, $checked)
  {
    @file_put_contents(self::STALE_SINCE_FILE, json_encode(['since' => $since, 'checked' => $checked]));
  }

  /**
   * Whether pm2 reports the API online, and how long its process has run.
   *
   * @return array{running: bool, uptime: ?int}
   */
  private static function apiProcess()
  {
    $out = [];
    exec(self::PATH_ENV . ' /usr/bin/timeout 15 unraid-api status 2>/dev/null', $out);
    $text = implode("\n", $out);
    $running = (bool) preg_match('/^status\s*:\s*online/mi', $text);
    $uptime = null;
    if ($running && preg_match('/^pid\s*:\s*(\d+)/mi', $text, $m)) {
      $etimes = trim((string) @shell_exec('/bin/ps -o etimes= -p ' . (int) $m[1] . ' 2>/dev/null'));
      $uptime = ctype_digit($etimes) ? (int) $etimes : null;
    }
    return ['running' => $running, 'uptime' => $uptime];
  }

  private static function rollBack($decision, array $in)
  {
    require_once PLUGIN_DIR . '/classes/Database.php';
    require_once PLUGIN_DIR . '/classes/CronManager.php';
    $db = Database::getInstance();
    // Only from graphql, so a user who switched in the meantime keeps theirs,
    // and gets no notification about a switch that did not happen.
    $changed = $db->update('settings', ['value' => 'php', 'updated_at' => time()], 'key = ? AND value = ?', ['backend_mode', 'graphql']);
    @unlink(self::STALE_SINCE_FILE);
    if ($changed === 0) {
      return;
    }
    CronManager::ensureSchedulerCron($db);

    $reason = [
      'load-failed' => 'The Unraid API did not load the GraphQL backend.',
      'not-installed' => 'The GraphQL backend is no longer installed in the Unraid API.',
      'offline' => 'The Unraid API is running, but its GraphQL service does not answer.',
      'no-api' => 'The Unraid API is running, but its GraphQL service does not answer.',
    ][$in['probe'] ?? ''] ?? 'The GraphQL backend stopped answering.';
    $removed = $decision === self::ROLLBACK_AND_REMOVE;
    // Every rollback takes the package out, because it stays only while the
    // mode is graphql. A plain rollback leaves the API running: the backend
    // was not loaded, or it was already removed with a restart once.
    $removeQuietly = !$removed && !empty($in['installed']);

    @file_put_contents(DFM_BACKEND_ROLLBACK_MARKER, json_encode([
      'at' => time(),
      'reason' => $reason,
      'removed' => $removed,
    ]) . "\n");

    $description = $reason . ' Docker Folders switched back to the PHP backend.'
      . ($removed ? ' It also removed the GraphQL backend and restarted the Unraid API.' : '');
    error_log('Docker Folders backend watchdog: ' . $description);
    sendUnraidNotification('Switched back to the PHP backend', $description, 'warning');

    if ($removed) {
      dfmLaunchApiPlugin('remove');
    } elseif ($removeQuietly) {
      dfmLaunchApiPlugin('remove-no-restart');
    }
  }
}
