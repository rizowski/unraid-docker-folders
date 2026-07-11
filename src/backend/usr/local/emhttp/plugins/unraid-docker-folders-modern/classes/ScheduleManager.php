<?php

require_once dirname(__DIR__) . '/include/config.php';
require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/DockerClient.php';
require_once __DIR__ . '/BackupManager.php';
require_once __DIR__ . '/WebSocketPublisher.php';

class ScheduleManager
{
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

  public function runDueSchedules()
  {
    $now = time();
    $due = $this->db->fetchAll(
      'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?',
      [$now]
    );

    $results = [];
    foreach ($due as $schedule) {
      $results[] = $this->executeSchedule($schedule['id']);
    }

    return $results;
  }

  public function executeSchedule($id)
  {
    $schedule = $this->db->fetchOne('SELECT * FROM schedules WHERE id = ?', [$id]);
    if (!$schedule) {
      return ['success' => false, 'error' => 'Schedule not found'];
    }

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

      return ['success' => $result['success'], 'schedule_id' => $id, 'status' => $status, 'message' => $message];
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

      return ['success' => false, 'schedule_id' => $id, 'status' => 'error', 'message' => $e->getMessage()];
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

    $id = $container['id'];
    switch ($action) {
      case 'start':
        $ok = $docker->startContainer($id);
        break;
      case 'stop':
        $ok = $docker->stopContainer($id);
        break;
      case 'pause':
        $ok = $docker->pauseContainer($id);
        break;
      case 'restart':
        $ok = $docker->restartContainer($id);
        break;
      default:
        return ['success' => false, 'message' => "Unknown action: {$action}"];
    }

    $msg = $ok ? ucfirst($action) . " succeeded for {$containerName}" : ucfirst($action) . " failed for {$containerName}: " . $docker->getLastError();
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

    if ($schedule['target_type'] === 'container') {
      return $backup->backupContainer($schedule['target_id'], $config['paths'], $destination, $retention);
    }

    return $backup->backupStack($schedule['target_id'], $config['paths'], $destination, $retention);
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
    return $value === $target;
  }
}
