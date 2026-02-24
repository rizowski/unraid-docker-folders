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
  errorResponse($e->getMessage(), 500);
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

  $dockerClient = new DockerClient();
  $db = Database::getInstance();
  $containers = $dockerClient->listContainers(true);

  // Load exclude patterns from settings
  $excludePatterns = [];
  $excludeRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_exclude'");
  if ($excludeRow && !empty($excludeRow['value'])) {
    $excludePatterns = array_map('trim', explode(',', $excludeRow['value']));
    $excludePatterns = array_filter($excludePatterns, function ($p) { return $p !== ''; });
  }

  // Collect unique images
  $uniqueImages = [];
  foreach ($containers as $container) {
    $image = $container['image'] ?? '';
    $imageId = $container['imageId'] ?? '';
    if ($image && !isset($uniqueImages[$image])) {
      $uniqueImages[$image] = $imageId;
    }
  }

  $results = [];

  foreach ($uniqueImages as $imageName => $imageId) {
    // Skip excluded images
    $excluded = false;
    foreach ($excludePatterns as $pattern) {
      if (fnmatch($pattern, $imageName)) {
        $excluded = true;
        break;
      }
    }
    if ($excluded) continue;
    $check = $dockerClient->checkImageUpdate($imageName, $imageId);

    // Upsert into database
    $stmt = $db->prepare(
      'INSERT OR REPLACE INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at, error)
       VALUES (:image, :local_digest, :remote_digest, :update_available, :checked_at, :error)'
    );
    $stmt->bindValue(':image', $imageName, SQLITE3_TEXT);
    $stmt->bindValue(':local_digest', $check['local_digest'], SQLITE3_TEXT);
    $stmt->bindValue(':remote_digest', $check['remote_digest'], SQLITE3_TEXT);
    $stmt->bindValue(':update_available', $check['update_available'] ? 1 : 0, SQLITE3_INTEGER);
    $stmt->bindValue(':checked_at', time(), SQLITE3_INTEGER);
    $stmt->bindValue(':error', $check['error'], SQLITE3_TEXT);
    $stmt->execute();

    $results[$imageName] = [
      'image' => $imageName,
      'local_digest' => $check['local_digest'],
      'remote_digest' => $check['remote_digest'],
      'update_available' => $check['update_available'],
      'checked_at' => time(),
      'error' => $check['error'],
    ];
  }

  WebSocketPublisher::publish('updates', 'checked');

  jsonResponse(['updates' => $results]);
}
