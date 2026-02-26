<?php
/**
 * Unraid Docker Folders - Image Updates API
 *
 * Check Docker registry for newer images and cache results.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';
require_once dirname(__DIR__) . '/classes/Database.php';
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

    case 'OPTIONS':
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Updates API error: ' . $e->getMessage());
  errorResponse('Internal server error', 500);
}

/**
 * Return cached update check results
 */
function handleGet()
{
  $db = Database::getInstance();
  $results = [];

  $stmt = $db->query('SELECT * FROM image_update_checks');
  if ($stmt) {
    while ($row = $stmt->fetchArray(SQLITE3_ASSOC)) {
      $results[$row['image']] = [
        'image' => $row['image'],
        'local_digest' => $row['local_digest'],
        'remote_digest' => $row['remote_digest'],
        'update_available' => (bool) $row['update_available'],
        'checked_at' => (int) $row['checked_at'],
        'error' => $row['error'],
      ];
    }
  }

  jsonResponse(['updates' => $results]);
}

/**
 * Check all container images for updates
 */
function handlePost()
{
  $action = $_GET['action'] ?? null;

  if ($action !== 'check') {
    errorResponse('Invalid action', 400);
  }

  logUpdate('START Manual update check begun');

  $dockerClient = new DockerClient();
  $db = Database::getInstance();

  $result = checkAllImageUpdates($dockerClient, $db, 'logUpdate');

  logUpdate('DONE Checked ' . $result['checked'] . ', skipped ' . $result['skipped'] . ', errors ' . $result['errors'] . ', updates ' . $result['newUpdates']);

  WebSocketPublisher::publish('updates', 'checked');

  jsonResponse(['updates' => $result['results']]);
}
