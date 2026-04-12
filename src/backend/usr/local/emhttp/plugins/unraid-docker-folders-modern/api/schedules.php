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

  jsonResponse(['schedules' => $manager->listSchedules($filters)]);
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

  $validTargetTypes = ['container', 'stack'];
  if (!in_array($data['target_type'], $validTargetTypes, true)) {
    errorResponse('Invalid target_type', 400);
  }

  $validActions = ['start', 'stop', 'pause', 'restart', 'backup'];
  if (!in_array($data['action'], $validActions, true)) {
    errorResponse('Invalid action', 400);
  }

  if ($data['action'] === 'backup' && empty($data['backup_config'])) {
    errorResponse('backup_config required for backup action', 400);
  }

  $id = $manager->createSchedule($data);

  WebSocketPublisher::publish('schedules', 'created', ['id' => $id]);
  jsonResponse(['success' => true, 'id' => $id], 201);
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
