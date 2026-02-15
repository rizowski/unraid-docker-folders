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

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'];

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
  errorResponse($e->getMessage(), 500);
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

  // Parse body — supports form-encoded payload field or direct JSON
  $body = file_get_contents('php://input');
  $data = null;

  if (isset($_POST['payload'])) {
    $data = json_decode($_POST['payload'], true);
  } elseif ($body) {
    parse_str($body, $parsed);
    if (isset($parsed['payload'])) {
      $data = json_decode($parsed['payload'], true);
    } else {
      $data = json_decode($body, true);
    }
  }

  if (!$data || !isset($data['key']) || !isset($data['value'])) {
    errorResponse('Missing key or value', 400);
  }

  $key = $data['key'];
  $value = $data['value'];
  $now = time();

  // Upsert: insert or update
  $existing = $db->fetchOne('SELECT key FROM settings WHERE key = ?', [$key]);

  if ($existing) {
    $db->update('settings', ['value' => $value, 'updated_at' => $now], 'key = ?', [$key]);
  } else {
    $db->insert('settings', ['key' => $key, 'value' => $value, 'updated_at' => $now]);
  }

  jsonResponse(['success' => true, 'key' => $key, 'value' => $value]);
}
