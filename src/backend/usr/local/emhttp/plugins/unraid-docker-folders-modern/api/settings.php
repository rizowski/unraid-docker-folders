<?php
/**
 * Unraid Docker Folders - Settings API
 *
 * Endpoints for managing plugin settings
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/CronManager.php';

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

    case 'OPTIONS':
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Settings API error: ' . $e->getMessage());
  errorResponse('Internal server error', 500);
}

function handleGet()
{
  $db = Database::getInstance();
  $rows = $db->fetchAll('SELECT key, value FROM settings');

  $settings = [];
  foreach ($rows as $row) {
    $settings[$row['key']] = $row['value'];
  }

  jsonResponse(['settings' => $settings]);
}

function handlePost()
{
  $db = Database::getInstance();
  $data = getRequestData();

  // Handle clear_log action
  if (isset($data['action']) && $data['action'] === 'clear_log') {
    $logPath = CONFIG_DIR . '/update-check.log';
    if (file_exists($logPath)) {
      file_put_contents($logPath, '');
    }
    jsonResponse(['success' => true]);
    return;
  }

  if (!$data || !isset($data['key']) || !isset($data['value'])) {
    errorResponse('Missing key or value', 400);
  }

  $key = $data['key'];
  $value = $data['value'];
  $now = time();

  // Validate key against allowlist
  $allowedKeys = [
    'distinguish_healthy', 'show_stats', 'replace_docker_section',
    'show_folder_ports', 'show_inline_logs', 'enable_update_checks',
    'update_check_schedule', 'notify_on_updates', 'update_check_exclude',
    'post_pull_action',
    'log_refresh_interval',
  ];
  if (!in_array($key, $allowedKeys, true)) {
    errorResponse('Invalid settings key', 400);
  }

  // Validate value length
  if (is_string($value) && strlen($value) > 10000) {
    errorResponse('Value too long', 400);
  }

  // Upsert: insert or update
  $existing = $db->fetchOne('SELECT key FROM settings WHERE key = ?', [$key]);

  if ($existing) {
    $db->update('settings', ['value' => $value, 'updated_at' => $now], 'key = ?', [$key]);
  } else {
    $db->insert('settings', ['key' => $key, 'value' => $value, 'updated_at' => $now]);
  }

  // When update_check_schedule changes, update or remove the cron file
  if ($key === 'update_check_schedule') {
    CronManager::updateSchedule($value);
  }

  // When update checks are disabled entirely, also remove the cron file
  if ($key === 'enable_update_checks' && $value === '0') {
    CronManager::removeSchedule();
    // Reset schedule setting to disabled
    $existing = $db->fetchOne('SELECT key FROM settings WHERE key = ?', ['update_check_schedule']);
    if ($existing) {
      $db->update('settings', ['value' => 'disabled', 'updated_at' => $now], 'key = ?', ['update_check_schedule']);
    }
  }

  jsonResponse(['success' => true, 'key' => $key, 'value' => $value]);
}
