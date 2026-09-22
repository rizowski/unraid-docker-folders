<?php

require_once dirname(__DIR__) . '/include/config.php';
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/DockerClient.php';
require_once __DIR__ . '/BackupManager.php';
require_once __DIR__ . '/WebSocketPublisher.php';

class ScheduleManager
{
  // How late a run may be and still go ahead. The runner fires every minute,
  // so normal lateness is under 60 seconds. Anything past this means the
  // runner was not active when the schedule came due.
  const MISFIRE_GRACE_SECONDS = 300;

  private $db;

  public function __construct()
  {
    $this->db = Database::getInstance();
  }

  public function listSchedules($filters = [])
  {
    $where = [];
    $params = [];

    if (!empty($filters['target_type'])) {
      $where[] = 'target_type = ?';
      $params[] = $filters['target_type'];
    }
    if (!empty($filters['target_id'])) {
      $where[] = 'target_id = ?';
      $params[] = $filters['target_id'];
    }
    if (isset($filters['enabled'])) {
      $where[] = 'enabled = ?';
      $params[] = $filters['enabled'] ? 1 : 0;
    }

    $sql = 'SELECT * FROM schedules';
    if ($where) {
      $sql .= ' WHERE ' . implode(' AND ', $where);
    }
    $sql .= ' ORDER BY name ASC';

    $rows = $this->db->fetchAll($sql, $params);
    return array_map([$this, 'formatSchedule'], $rows);
  }

  public function getSchedule($id)
  {
    $row = $this->db->fetchOne('SELECT * FROM schedules WHERE id = ?', [$id]);
    return $row ? $this->formatSchedule($row) : null;
  }

  public function createSchedule($data)
  {
    $now = time();
    $cronExpr = $data['cron_expression'];

    if (!self::validateCronExpression($cronExpr)) {
      throw new InvalidArgumentException('Invalid cron expression');
    }

    $nextRun = self::computeNextRun($cronExpr, $now);

    $backupConfig = null;
    if ($data['action'] === 'backup') {
      if (empty($data['backup_config'])) {
        throw new InvalidArgumentException('Backup config required for backup action');
      }
      $backupConfig = is_string($data['backup_config'])
        ? $data['backup_config']
        : json_encode($data['backup_config']);
    }

    $id = $this->db->insert('schedules', [
      'name' => $data['name'],
      'target_type' => $data['target_type'],
      'target_id' => $data['target_id'],
      'action' => $data['action'],
      'cron_expression' => $cronExpr,
      'enabled' => isset($data['enabled']) ? ($data['enabled'] ? 1 : 0) : 1,
      'backup_config' => $backupConfig,
      'next_run_at' => $nextRun,
      'created_at' => $now,
      'updated_at' => $now,
    ]);

    CronManager::ensureSchedulerCron($this->db);

    return $id;
  }

  public function updateSchedule($id, $data)
  {
    $schedule = $this->db->fetchOne('SELECT * FROM schedules WHERE id = ?', [$id]);
    if (!$schedule) {
      return false;
    }

    $update = ['updated_at' => time()];

    $fields = ['name', 'target_type', 'target_id', 'action', 'enabled'];
    foreach ($fields as $field) {
      if (isset($data[$field])) {
        $update[$field] = $field === 'enabled' ? ($data[$field] ? 1 : 0) : $data[$field];
      }
    }

    if (isset($data['cron_expression'])) {
      if (!self::validateCronExpression($data['cron_expression'])) {
        throw new InvalidArgumentException('Invalid cron expression');
      }
      $update['cron_expression'] = $data['cron_expression'];
      $update['next_run_at'] = self::computeNextRun($data['cron_expression'], time());
    }

    // Turning a schedule back on must move it forward, exactly as
    // toggleSchedule() does. A row disabled last week still carries last
    // week's next_run_at, which is in the past and fires on the next tick.
    // The edit form always sends cron_expression, so only a PUT carrying just
    // `enabled` reaches this, but the stale value is real either way.
    if ((int) $schedule['enabled'] === 0 && !empty($update['enabled']) && !isset($update['next_run_at'])) {
      $cronExpr = isset($update['cron_expression'])
        ? $update['cron_expression']
        : $schedule['cron_expression'];
      $update['next_run_at'] = self::computeNextRun($cronExpr, time());
    }

    if (isset($data['backup_config'])) {
      $update['backup_config'] = is_string($data['backup_config'])
        ? $data['backup_config']
        : json_encode($data['backup_config']);
    }

    $this->db->update('schedules', $update, 'id = ?', [$id]);

    CronManager::ensureSchedulerCron($this->db);

    return true;
  }

  public function deleteSchedule($id)
  {
    $this->db->delete('schedules', 'id = ?', [$id]);
    CronManager::ensureSchedulerCron($this->db);
    return true;
  }

  public function toggleSchedule($id, $enabled)
  {
    $update = [
      'enabled' => $enabled ? 1 : 0,
      'updated_at' => time(),
    ];

    if ($enabled) {
      $schedule = $this->db->fetchOne('SELECT cron_expression FROM schedules WHERE id = ?', [$id]);
      if ($schedule) {
        $update['next_run_at'] = self::computeNextRun($schedule['cron_expression'], time());
      }
    }

    $this->db->update('schedules', $update, 'id = ?', [$id]);
    CronManager::ensureSchedulerCron($this->db);
    return true;
  }

  /**
   * Apply enabled/disabled to many schedules in one transaction.
   *
   * $updates is a list of ['id' => int, 'enabled' => bool]. Rows may move in
   * either direction in the same call, which is why this takes a per-row value
   * rather than one flag for the whole set.
   *
   * Rewrites next_run_at for rows being enabled, exactly as toggleSchedule
   * does, but rebuilds the scheduler cron once at the end instead of per row.
   *
   * Returns the number of rows updated. Ids that no longer exist are skipped.
   */
  public function bulkSetEnabled($updates)
  {
    if (empty($updates)) {
      return 0;
    }

    $now = time();
    $changed = 0;

    $this->db->beginTransaction();
    try {
      foreach ($updates as $entry) {
        $id = isset($entry['id']) ? (int) $entry['id'] : 0;
        if (!$id) {
          continue;
        }
        $enabled = !empty($entry['enabled']);

        $schedule = $this->db->fetchOne('SELECT cron_expression FROM schedules WHERE id = ?', [$id]);
        if (!$schedule) {
          continue;
        }

        $update = [
          'enabled' => $enabled ? 1 : 0,
          'updated_at' => $now,
        ];
        if ($enabled) {
          $update['next_run_at'] = self::computeNextRun($schedule['cron_expression'], $now);
        }

        $this->db->update('schedules', $update, 'id = ?', [$id]);
        $changed++;
      }
      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      throw $e;
    }

    CronManager::ensureSchedulerCron($this->db);

    return $changed;
  }

  /**
   * Delete many schedules in one transaction, rebuilding the scheduler cron
   * once at the end. Returns the number of ids acted on.
   */
  public function bulkDelete($ids)
  {
    if (empty($ids)) {
      return 0;
    }

    $deleted = 0;

    $this->db->beginTransaction();
    try {
      foreach ($ids as $rawId) {
        $id = (int) $rawId;
        if (!$id) {
          continue;
        }
        $this->db->delete('schedules', 'id = ?', [$id]);
        $deleted++;
      }
      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      throw $e;
    }

    CronManager::ensureSchedulerCron($this->db);

    return $deleted;
  }

  /**
   * Recompute next_run_at for every enabled schedule.
   *
   * Needed whenever the interpretation of a cron expression could have
   * changed without the expression itself changing — e.g. after config.php
   * starts resolving the server's actual timezone instead of always using
   * UTC. Existing next_run_at values would otherwise still reflect the old
   * zone until each schedule happened to fire or be edited.
   *
   * Returns the number of schedules updated.
   */
  public function recomputeAllNextRuns()
  {
    $rows = $this->db->fetchAll('SELECT id, cron_expression FROM schedules WHERE enabled = 1');

    $now = time();
    $count = 0;
    $this->db->beginTransaction();
    try {
      foreach ($rows as $row) {
        $nextRun = self::computeNextRun($row['cron_expression'], $now);
        if ($nextRun === null) {
          // Unparseable expression (shouldn't happen — validateCronExpression
          // gates writes — but next_run_at is polled with `<= ?`, which a NULL
          // would never satisfy, silently disabling the schedule forever).
          continue;
        }
        $this->db->update('schedules', ['next_run_at' => $nextRun], 'id = ?', [$row['id']]);
        $count++;
      }
      $this->db->commit();
    } catch (Exception $e) {
      $this->db->rollback();
      throw $e;
    }

    return $count;
  }

  /**
   * Decide whether an overdue run is too late to go ahead.
   *
   * A late backup that only reads files is still worth having, so it catches
   * up. A late start/stop/pause/resume/restart is a surprise state change in
   * the middle of the working day, so those are skipped instead.
   *
   * A backup that pauses or stops its container is a state change too. Without
   * this, a 3:00 AM backup in stop mode that catches up at 9:40 AM takes the
   * container down at 9:40 AM, which is the surprise this rule exists to stop.
   *
   * Pure and static on purpose: ScheduleManager's constructor needs a real
   * database, and the tests must reach this rule without one.
   *
   * @param string $action The schedule's action
   * @param int $lateBySeconds now() minus next_run_at
   * @param string $quiesce The backup's quiesce mode, 'none' for every other action
   * @return bool
   */
  public static function shouldSkipMissedRun($action, $lateBySeconds, $quiesce = BackupManager::QUIESCE_NONE)
  {
    if ($action === 'backup' && BackupManager::quiesceModeFor($quiesce) === BackupManager::QUIESCE_NONE) {
      return false;
    }

    return $lateBySeconds > self::MISFIRE_GRACE_SECONDS;
  }

  /**
   * Read the quiesce mode off a schedule row.
   *
   * Accepts the raw row, where backup_config is a JSON string, and a formatted
   * schedule, where it is already an array.
   *
   * @param array $schedule
   * @return string
   */
  public static function scheduleQuiesceMode($schedule)
  {
    if ((isset($schedule['action']) ? $schedule['action'] : '') !== 'backup') {
      return BackupManager::QUIESCE_NONE;
    }

    $config = isset($schedule['backup_config']) ? $schedule['backup_config'] : null;
    if (is_string($config)) {
      $config = json_decode($config, true);
    }

    return BackupManager::quiesceModeFor(
      is_array($config) && isset($config['quiesce']) ? $config['quiesce'] : null
    );
  }

  public function runDueSchedules()
  {
    $now = time();
    $due = $this->db->fetchAll(
      'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?',
      [$now]
    );

    $results = [];
    foreach ($due as $schedule) {
      if (!$this->claimSlot($schedule, $now)) {
        continue;
      }
      $lateBy = $now - (int) $schedule['next_run_at'];

      if (self::shouldSkipMissedRun($schedule['action'], $lateBy, self::scheduleQuiesceMode($schedule))) {
        $results[] = $this->skipSchedule($schedule, $lateBy);
        continue;
      }

      $results[] = $this->executeSchedule($schedule['id']);
    }

    return $results;
  }

  /**
   * Take this slot, or learn that another runner already took it.
   *
   * Moves next_run_at past the slot only if it still holds the value this
   * runner read. The Unraid API plugin runs schedules too, and around a
   * backend-mode switch or a restart both runners can find the same row due
   * in the same minute. The flock in run-schedules.php only keeps PHP from
   * racing itself, so without this compare-and-set both run the action.
   * executeSchedule() sets next_run_at again when the run finishes.
   *
   * @param array $schedule The full schedules row, as read by the runner
   * @param int $now The runner's clock for this pass
   * @return bool True if this runner owns the slot
   */
  private function claimSlot(array $schedule, $now)
  {
    return $this->db->update(
      'schedules',
      ['next_run_at' => self::computeNextRun($schedule['cron_expression'], $now)],
      'id = ? AND enabled = 1 AND next_run_at = ?',
      [(int) $schedule['id'], (int) $schedule['next_run_at']]
    ) === 1;
  }

  /**
   * Record an overdue run as skipped and move it to its next slot.
   *
   * Mirrors the bookkeeping tail of executeSchedule(), minus the action.
   *
   * @param array $schedule The full schedules row
   * @param int $lateBySeconds How far past next_run_at the runner found it
   * @return array Result shaped like executeSchedule()'s, with status 'skipped'
   */
  private function skipSchedule(array $schedule, $lateBySeconds)
  {
    $id = (int) $schedule['id'];
    $now = time();
    $message = 'Skipped: ' . formatRunLateness($lateBySeconds) . ' past scheduled time';

    $this->db->insert('schedule_history', [
      'schedule_id' => $id,
      'started_at' => $now,
      'finished_at' => $now,
      'status' => 'skipped',
      'message' => $message,
    ]);

    // Computed from now(), never from the stale next_run_at. Advancing from
    // the missed slot would land on another past time, which would be skipped
    // again on the next tick, writing a history row every minute forever.
    $this->db->update('schedules', [
      'last_run_at' => $now,
      'last_run_status' => 'skipped',
      'last_run_message' => $message,
      'next_run_at' => self::computeNextRun($schedule['cron_expression'], $now),
      'updated_at' => $now,
    ], 'id = ?', [$id]);

    $this->pruneHistory($id);

    return [
      'success' => true,
      'schedule_id' => $id,
      'status' => 'skipped',
      'message' => $message,
      'late_by' => $lateBySeconds,
      'name' => $schedule['name'],
      'target_type' => $schedule['target_type'],
      'target_id' => $schedule['target_id'],
      'action' => $schedule['action'],
    ];
  }

  public function executeSchedule($id)
  {
    $schedule = $this->db->fetchOne('SELECT * FROM schedules WHERE id = ?', [$id]);
    if (!$schedule) {
      return ['success' => false, 'message' => 'Schedule not found'];
    }

    // The runner names the schedule and its target in a failure notification.
    $about = [
      'name' => $schedule['name'],
      'target_type' => $schedule['target_type'],
      'target_id' => $schedule['target_id'],
      'action' => $schedule['action'],
    ];

    $startedAt = time();
    $historyId = $this->db->insert('schedule_history', [
      'schedule_id' => $id,
      'started_at' => $startedAt,
      'status' => 'running',
    ]);

    try {
      $result = $this->dispatchAction($schedule);
      $status = $result['success'] ? 'success' : 'error';
      $message = $result['message'] ?? '';

      $historyUpdate = [
        'finished_at' => time(),
        'status' => $status,
        'message' => $message,
      ];
      if (!empty($result['backup_file'])) {
        $historyUpdate['backup_file'] = $result['backup_file'];
        $historyUpdate['backup_size'] = $result['backup_size'] ?? 0;
      }

      $this->db->update('schedule_history', $historyUpdate, 'id = ?', [$historyId]);

      $this->db->update('schedules', [
        'last_run_at' => $startedAt,
        'last_run_status' => $status,
        'last_run_message' => $message,
        'next_run_at' => self::computeNextRun($schedule['cron_expression'], time()),
        'updated_at' => time(),
      ], 'id = ?', [$id]);

      $this->pruneHistory($id);

      return ['success' => $result['success'], 'schedule_id' => $id, 'status' => $status, 'message' => $message] + $about;
    } catch (Exception $e) {
      $this->db->update('schedule_history', [
        'finished_at' => time(),
        'status' => 'error',
        'message' => $e->getMessage(),
      ], 'id = ?', [$historyId]);

      $this->db->update('schedules', [
        'last_run_at' => $startedAt,
        'last_run_status' => 'error',
        'last_run_message' => $e->getMessage(),
        'next_run_at' => self::computeNextRun($schedule['cron_expression'], time()),
        'updated_at' => time(),
      ], 'id = ?', [$id]);

      return ['success' => false, 'schedule_id' => $id, 'status' => 'error', 'message' => $e->getMessage()] + $about;
    }
  }

  public function getHistory($scheduleId, $limit = 50)
  {
    return $this->db->fetchAll(
      'SELECT * FROM schedule_history WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?',
      [$scheduleId, $limit]
    );
  }

  private function pruneHistory($scheduleId, $keep = 200)
  {
    $cutoff = $this->db->fetchValue(
      'SELECT started_at FROM schedule_history WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1 OFFSET ?',
      [$scheduleId, $keep]
    );
    if ($cutoff) {
      $this->db->delete('schedule_history', 'schedule_id = ? AND started_at < ?', [$scheduleId, $cutoff]);
    }
  }

  private function dispatchAction($schedule)
  {
    if ($schedule['action'] === 'backup') {
      return $this->executeBackup($schedule);
    }

    if ($schedule['target_type'] === 'container') {
      return $this->executeContainerAction($schedule['target_id'], $schedule['action']);
    }

    return $this->executeStackAction($schedule['target_id'], $schedule['action']);
  }

  /**
   * Maps a schedule action + current container state to the DockerClient
   * method that carries it out. Public static so it is unit-testable without
   * constructing ScheduleManager, which requires a live Database::getInstance().
   *
   * 'start' resumes a paused container instead of asking Docker to start an
   * already-running one (which is a no-op start would otherwise attempt).
   * 'resume' always unpauses, regardless of state — see executeContainerAction
   * for the no-op-when-not-paused special case.
   *
   * Returns the pre-existing DockerClient::unpauseContainer method name for
   * both 'start'-while-paused and 'resume' — that method itself is not
   * renamed, only the action identifiers that select it.
   */
  public static function resolveContainerMethod($action)
  {
    // 'start' needs no state: DockerClient::startContainer resumes a paused
    // container itself, so the rule lives in one place for every caller.
    switch ($action) {
      case 'start':
        return 'startContainer';
      case 'resume':
        return 'unpauseContainer';
      case 'stop':
        return 'stopContainer';
      case 'pause':
        return 'pauseContainer';
      case 'restart':
        return 'restartContainer';
      default:
        return null;
    }
  }

  private function executeContainerAction($containerName, $action)
  {
    $docker = new DockerClient();
    $containers = $docker->listContainers(true);

    $container = null;
    foreach ($containers as $c) {
      if ($c['name'] === $containerName) {
        $container = $c;
        break;
      }
    }

    if (!$container) {
      return ['success' => false, 'message' => "Container '{$containerName}' not found"];
    }

    $state = $container['state'] ?? '';
    $method = self::resolveContainerMethod($action);
    if ($method === null) {
      return ['success' => false, 'message' => "Unknown action: {$action}"];
    }

    // A resume schedule firing against an already-running container is not an
    // error; there's simply nothing to do.
    if ($action === 'resume' && $state !== 'paused') {
      return ['success' => true, 'message' => "{$containerName} is not paused; nothing to do"];
    }

    $id = $container['id'];
    $ok = $docker->$method($id);
    $verb = ucfirst($action);
    $msg = $ok ? "{$verb} succeeded for {$containerName}" : "{$verb} failed for {$containerName}: " . $docker->getLastError();
    return ['success' => $ok, 'message' => $msg];
  }

  private function executeStackAction($projectName, $action)
  {
    require_once __DIR__ . '/ComposeManager.php';
    $compose = new ComposeManager();

    switch ($action) {
      case 'start':
        $result = $compose->stackUp($projectName);
        break;
      case 'stop':
        $result = $compose->stackStop($projectName);
        break;
      case 'pause':
        return ['success' => false, 'message' => 'Pause is not supported for compose stacks'];
      case 'resume':
        return ['success' => false, 'message' => 'Resume is not supported for compose stacks'];
      case 'restart':
        $result = $compose->stackRestart($projectName);
        break;
      default:
        return ['success' => false, 'message' => "Unknown action: {$action}"];
    }

    $msg = $result['success']
      ? ucfirst($action) . " succeeded for stack {$projectName}"
      : ucfirst($action) . " failed for stack {$projectName}: " . ($result['output'] ?? '');
    return ['success' => $result['success'], 'message' => $msg];
  }

  private function executeBackup($schedule)
  {
    $config = json_decode($schedule['backup_config'], true);
    if (!$config || empty($config['paths'])) {
      return ['success' => false, 'message' => 'Invalid backup configuration'];
    }

    $backup = new BackupManager();
    $destination = !empty($config['destination']) ? $config['destination'] : null;
    $retention = !empty($config['retention_count']) ? (int) $config['retention_count'] : null;

    // Coerced to one of three known strings. It never reaches a shell, but an
    // unknown value must mean "leave the container alone", not a fatal error
    // in the middle of a scheduled run.
    $quiesce = BackupManager::quiesceModeFor(isset($config['quiesce']) ? $config['quiesce'] : null);

    if ($schedule['target_type'] === 'container') {
      return $backup->backupContainer($schedule['target_id'], $config['paths'], $destination, $retention, $quiesce);
    }

    return $backup->backupStack($schedule['target_id'], $config['paths'], $destination, $retention, $quiesce);
  }

  private function formatSchedule($row)
  {
    $row['enabled'] = (bool) $row['enabled'];
    if ($row['backup_config']) {
      $row['backup_config'] = json_decode($row['backup_config'], true);
    }
    return $row;
  }

  // --- Cron Expression Parser ---

  public static function validateCronExpression($expr)
  {
    $parts = preg_split('/\s+/', trim($expr));
    if (count($parts) !== 5) {
      return false;
    }

    $ranges = [
      [0, 59],  // minute
      [0, 23],  // hour
      [1, 31],  // day of month
      [1, 12],  // month
      [0, 7],   // day of week (0 and 7 = Sunday)
    ];

    for ($i = 0; $i < 5; $i++) {
      if (!self::validateCronField($parts[$i], $ranges[$i][0], $ranges[$i][1])) {
        return false;
      }
    }

    return true;
  }

  private static function validateCronField($field, $min, $max)
  {
    $segments = explode(',', $field);
    foreach ($segments as $segment) {
      if (!self::validateCronSegment($segment, $min, $max)) {
        return false;
      }
    }
    return true;
  }

  private static function validateCronSegment($segment, $min, $max)
  {
    // step: */N or range/N
    if (strpos($segment, '/') !== false) {
      $parts = explode('/', $segment, 2);
      if (!is_numeric($parts[1]) || (int) $parts[1] < 1) {
        return false;
      }
      $segment = $parts[0];
      if ($segment === '*') {
        return true;
      }
    }

    // wildcard
    if ($segment === '*') {
      return true;
    }

    // range: N-M
    if (strpos($segment, '-') !== false) {
      $parts = explode('-', $segment, 2);
      if (!is_numeric($parts[0]) || !is_numeric($parts[1])) {
        return false;
      }
      $lo = (int) $parts[0];
      $hi = (int) $parts[1];
      return $lo >= $min && $hi <= $max && $lo <= $hi;
    }

    // single number
    if (is_numeric($segment)) {
      $val = (int) $segment;
      return $val >= $min && $val <= $max;
    }

    return false;
  }

  public static function computeNextRun($cronExpr, $afterTimestamp = null)
  {
    if ($afterTimestamp === null) {
      $afterTimestamp = time();
    }

    $parts = preg_split('/\s+/', trim($cronExpr));
    if (count($parts) !== 5) {
      return null;
    }

    // Start from the next minute
    $t = $afterTimestamp - ($afterTimestamp % 60) + 60;

    // Search up to 366 days
    $limit = $t + 366 * 86400;

    while ($t < $limit) {
      $mon = (int) date('n', $t);
      if (!self::cronFieldMatches($parts[3], $mon)) {
        // Skip to 1st of next month at 00:00
        $t = mktime(0, 0, 0, $mon + 1, 1, (int) date('Y', $t));
        continue;
      }

      $dom = (int) date('j', $t);
      $dow = (int) date('w', $t);
      if (!self::cronFieldMatches($parts[2], $dom) || !self::cronFieldMatches($parts[4], $dow, true)) {
        // Skip to next day at 00:00
        $t = mktime(0, 0, 0, $mon, $dom + 1, (int) date('Y', $t));
        continue;
      }

      $h = (int) date('G', $t);
      if (!self::cronFieldMatches($parts[1], $h)) {
        // Skip to next hour
        $t = mktime($h + 1, 0, 0, $mon, $dom, (int) date('Y', $t));
        continue;
      }

      $m = (int) date('i', $t);
      if (self::cronFieldMatches($parts[0], $m)) {
        return $t;
      }

      $t += 60;
    }

    return null;
  }

  private static function cronFieldMatches($field, $value, $isDow = false)
  {
    $segments = explode(',', $field);
    foreach ($segments as $segment) {
      if (self::cronSegmentMatches($segment, $value, $isDow)) {
        return true;
      }
    }
    return false;
  }

  private static function cronSegmentMatches($segment, $value, $isDow = false)
  {
    $step = 1;
    if (strpos($segment, '/') !== false) {
      list($segment, $step) = explode('/', $segment, 2);
      $step = (int) $step;
    }

    if ($segment === '*') {
      return $step === 1 ? true : ($value % $step === 0);
    }

    if (strpos($segment, '-') !== false) {
      list($lo, $hi) = explode('-', $segment, 2);
      $lo = (int) $lo;
      $hi = (int) $hi;
      if ($value < $lo || $value > $hi) {
        return false;
      }
      return ($value - $lo) % $step === 0;
    }

    $target = (int) $segment;
    // 7 = Sunday in some cron implementations
    if ($isDow && $target === 7) {
      $target = 0;
    }
    // N/S is shorthand for N-<field max>/S: "0/3" in the minute field means
    // 0, 3, 6, ... 57, not minute 0 only. $value never exceeds the field max,
    // so the upper bound needs no check.
    if ($step !== 1) {
      return $value >= $target && ($value - $target) % $step === 0;
    }
    return $value === $target;
  }
}
