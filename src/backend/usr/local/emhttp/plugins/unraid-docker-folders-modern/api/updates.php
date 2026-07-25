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
        'source_url' => $row['source_url'] ?? null,
      ];
    }
  }

  jsonResponse(['updates' => $results]);
}

/**
 * Check container images for updates.
 *
 * With no payload, checks every container image. An optional JSON payload
 * `{"images": ["linuxserver/plex:latest", ...]}` restricts the check to
 * those images (used for per-container / per-stack checks).
 */
function handlePost()
{
  $action = $_GET['action'] ?? null;

  if ($action !== 'check') {
    errorResponse('Invalid action', 400);
  }

  // Optional targeted check: list of image references to check
  $onlyImages = null;
  $data = getRequestData();
  if (is_array($data) && isset($data['images'])) {
    if (!is_array($data['images'])) {
      errorResponse('images must be an array of image references', 400);
    }
    $onlyImages = array_values(array_filter($data['images'], function ($img) {
      return is_string($img) && $img !== '';
    }));
    if (empty($onlyImages)) {
      errorResponse('images must contain at least one image reference', 400);
    }
  }

  // Allow unlimited execution time — registry checks can take 15s each
  set_time_limit(0);
  ignore_user_abort(true);

  logUpdate($onlyImages !== null
    ? 'START Targeted update check begun (' . count($onlyImages) . ' image(s))'
    : 'START Manual update check begun');

  $dockerClient = new DockerClient();
  $db = Database::getInstance();

  $result = checkAllImageUpdates($dockerClient, $db, 'logUpdate', $onlyImages);

  logUpdate('DONE Checked ' . $result['checked'] . ', skipped ' . $result['skipped'] . ', errors ' . $result['errors'] . ', updates ' . $result['newUpdates']);

  WebSocketPublisher::publish('updates', 'checked');

  jsonResponse(['updates' => $result['results']]);
}
