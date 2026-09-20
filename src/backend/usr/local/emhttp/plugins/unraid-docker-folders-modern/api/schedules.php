<?php

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';
require_once dirname(__DIR__) . '/classes/ScheduleManager.php';
require_once dirname(__DIR__) . '/classes/BackupManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'];

requireAuth();

try {
  switch ($method) {
    case 'GET':
      handleGet();
      break;
    case 'POST':
      handlePost();
      break;
    case 'PUT':
      requireCsrf();
      handlePut();
      break;
    case 'DELETE':
      requireCsrf();
      handleDelete();
      break;
    case 'OPTIONS':
      http_response_code(200);
      exit();
    default:
      errorResponse('Method not allowed', 405);
  }
} catch (InvalidArgumentException $e) {
  errorResponse($e->getMessage(), 400);
} catch (Exception $e) {
  error_log('Schedules API error: ' . $e->getMessage());
  errorResponse('Internal server error', 500);
}

function handleGet()
{
  $manager = new ScheduleManager();
  $action = $_GET['action'] ?? null;

  if ($action === 'history') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if (!$id) {
      errorResponse('Missing schedule id', 400);
    }
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
    jsonResponse(['history' => $manager->getHistory($id, $limit)]);
    return;
  }

  if ($action === 'backups') {
    $targetType = $_GET['target_type'] ?? '';
    $targetId = $_GET['target_id'] ?? '';
    if (!$targetType || !$targetId) {
      errorResponse('Missing target_type or target_id', 400);
    }
    $backup = new BackupManager();
    jsonResponse(['backups' => $backup->listBackups($targetType, $targetId)]);
    return;
  }

  if (isset($_GET['id'])) {
    $schedule = $manager->getSchedule((int) $_GET['id']);
    if (!$schedule) {
      errorResponse('Schedule not found', 404);
    }
    jsonResponse(['schedule' => $schedule]);
    return;
  }

  $filters = [];
  if (isset($_GET['target_type'])) {
    $filters['target_type'] = $_GET['target_type'];
  }
  if (isset($_GET['target_id'])) {
    $filters['target_id'] = $_GET['target_id'];
  }

  jsonResponse([
    'schedules' => $manager->listSchedules($filters),
    'runner' => runnerState(),
  ]);
}

/**
 * Health of the per-minute schedule runner, for the warning row in the UI.
 *
 * last_tick is the mtime of the heartbeat file the runner touches on every
 * cron invocation. crontab -l is only read when that heartbeat is missing or
 * stale: a fresh tick already proves the entry is installed, and this runs on
 * every load of the schedules screen.
 */
function runnerState()
{
  $lastTick = file_exists(SCHEDULER_TICK_FILE) ? filemtime(SCHEDULER_TICK_FILE) : null;
  $fresh = $lastTick !== null && (time() - $lastTick) <= SCHEDULER_TICK_STALE_SECONDS;

  // The staleness decision belongs here, not in the browser. last_tick is a
  // server timestamp, and the frontend holds the response until something
  // refetches, so comparing it against the browser clock would both drift with
  // the open tab and skew with any clock difference between the two machines.
  return [
    'last_tick' => $lastTick,
    'stale' => !$fresh,
    'stale_after' => SCHEDULER_TICK_STALE_SECONDS,
    'cron_installed' => $fresh ? true : CronManager::isSchedulerInstalled(),
  ];
}

function handlePost()
{
  $manager = new ScheduleManager();
  $action = $_GET['action'] ?? null;

  if ($action === 'toggle') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if (!$id) {
      errorResponse('Missing schedule id', 400);
    }
    $data = getRequestData();
    $enabled = isset($data['enabled']) ? (bool) $data['enabled'] : true;
    $manager->toggleSchedule($id, $enabled);
    WebSocketPublisher::publish('schedules', 'toggled', ['id' => $id]);
    jsonResponse(['success' => true]);
    return;
  }

  // Apply many enable/disable changes at once. Body: { updates: [{ id, enabled }] }.
  // Takes a per-row value because the UI stages changes in both directions and
  // commits them together.
  if ($action === 'bulk_toggle') {
    $data = getRequestData();
    $updates = isset($data['updates']) && is_array($data['updates']) ? $data['updates'] : null;
    if ($updates === null) {
      errorResponse('Missing updates array', 400);
    }
    $changed = $manager->bulkSetEnabled($updates);
    WebSocketPublisher::publish('schedules', 'toggled', ['count' => $changed]);
    jsonResponse(['success' => true, 'changed' => $changed]);
    return;
  }

  // Delete many schedules at once. Body: { ids: [1, 2, 3] }.
  if ($action === 'bulk_delete') {
    $data = getRequestData();
    $ids = isset($data['ids']) && is_array($data['ids']) ? $data['ids'] : null;
    if ($ids === null) {
      errorResponse('Missing ids array', 400);
    }
    $deleted = $manager->bulkDelete($ids);
    WebSocketPublisher::publish('schedules', 'deleted', ['count' => $deleted]);
    jsonResponse(['success' => true, 'deleted' => $deleted]);
    return;
  }

  // Rewrite the .cron file and rebuild root's crontab. Reached from the
  // warning row the UI shows when the runner heartbeat goes stale.
  if ($action === 'repair_cron') {
    CronManager::ensureSchedulerCron();
    jsonResponse(['success' => true, 'runner' => runnerState()]);
    return;
  }

  if ($action === 'run') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if (!$id) {
      errorResponse('Missing schedule id', 400);
    }
    $result = $manager->executeSchedule($id);
    WebSocketPublisher::publish('schedules', 'executed', ['id' => $id]);
    jsonResponse($result);
    return;
  }

  if ($action === 'delete_backup') {
    $data = getRequestData();
    if (empty($data['path'])) {
      errorResponse('Missing backup path', 400);
    }
    $backup = new BackupManager();
    $ok = $backup->deleteBackup($data['path']);
    if (!$ok) {
      errorResponse('Failed to delete backup', 400);
    }
    jsonResponse(['success' => true]);
    return;
  }

  // Create new schedule
  $data = getRequestData();
  if (!$data) {
    errorResponse('Invalid request data', 400);
  }

  $required = ['name', 'target_type', 'target_id', 'action', 'cron_expression'];
  foreach ($required as $field) {
    if (empty($data[$field])) {
      errorResponse("Missing required field: {$field}", 400);
    }
  }

  validateScheduleFields($data);

  if ($data['action'] === 'backup' && empty($data['backup_config'])) {
    errorResponse('backup_config required for backup action', 400);
  }

  $id = $manager->createSchedule($data);

  WebSocketPublisher::publish('schedules', 'created', ['id' => $id]);
  jsonResponse(['success' => true, 'id' => $id], 201);
}

/**
 * Reject a target_type or action outside the allowlist with a 400. Checks only
 * the fields that are present, so POST (all required) and a partial PUT share it.
 * Must match the CHECK constraints on the schedules table (migration 015).
 */
function validateScheduleFields($data)
{
  if (isset($data['target_type']) && !in_array($data['target_type'], ['container', 'stack'], true)) {
    errorResponse('Invalid target_type', 400);
  }

  $validActions = ['start', 'stop', 'pause', 'resume', 'restart', 'backup'];
  if (isset($data['action']) && !in_array($data['action'], $validActions, true)) {
    errorResponse('Invalid action', 400);
  }
}

function handlePut()
{
  $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
  if (!$id) {
    errorResponse('Missing schedule id', 400);
  }

  $data = getRequestData();
  if (!$data) {
    errorResponse('Invalid request data', 400);
  }

  validateScheduleFields($data);

  $manager = new ScheduleManager();
  $ok = $manager->updateSchedule($id, $data);

  if (!$ok) {
    errorResponse('Schedule not found', 404);
  }

  WebSocketPublisher::publish('schedules', 'updated', ['id' => $id]);
  jsonResponse(['success' => true]);
}

function handleDelete()
{
  $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
  if (!$id) {
    errorResponse('Missing schedule id', 400);
  }

  $manager = new ScheduleManager();
  $manager->deleteSchedule($id);

  WebSocketPublisher::publish('schedules', 'deleted', ['id' => $id]);
  jsonResponse(['success' => true]);
}
