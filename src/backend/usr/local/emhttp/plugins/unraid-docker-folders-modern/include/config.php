<?php
/**
 * Unraid Docker Folders - Configuration
 *
 * @package UnraidDockerModern
 */

// Plugin information
define('PLUGIN_NAME', 'unraid-docker-folders-modern');
define('PLUGIN_VERSION', '1.0.0');
define('PLUGIN_AUTHOR', 'rizowski');

// Paths
define('PLUGIN_DIR', '/usr/local/emhttp/plugins/' . PLUGIN_NAME);
define('CONFIG_DIR', '/boot/config/plugins/' . PLUGIN_NAME);
define('DATA_DIR', CONFIG_DIR . '/data');
define('BACKUP_DIR', CONFIG_DIR . '/backups');

// Database
define('DB_PATH', CONFIG_DIR . '/data.db');

// Logging
define('UPDATE_LOG_PATH', CONFIG_DIR . '/update-check.log');
define('UPDATE_LOG_MAX_BYTES', 64 * 1024); // 64 KB max

// Docker
define('DOCKER_SOCKET', '/var/run/docker.sock');
define('DOCKER_API_VERSION', 'v1.41');

// nchan WebSocket
define('NCHAN_PUB_URL', 'http://localhost:4433/pub/docker-modern');
define('NCHAN_SUB_PATH', '/sub/docker-modern');

// Error reporting (disable in production)
if (defined('DEBUG') && DEBUG) {
  error_reporting(E_ALL);
  ini_set('display_errors', '1');
} else {
  error_reporting(0);
  ini_set('display_errors', '0');
}

// Timezone
date_default_timezone_set('UTC');

/**
 * Read JSON request data from the request body.
 * Checks $_POST['payload'] first (form-encoded alongside csrf_token),
 * then parses php://input as URL-encoded (for PUT/DELETE where PHP
 * doesn't populate $_POST), falls back to raw JSON.
 *
 * Requires auth.php to be loaded first (for getRawBody()).
 *
 * @return array|null Decoded JSON data or null on failure
 */
function getRequestData()
{
  if (isset($_POST['payload'])) {
    return json_decode($_POST['payload'], true);
  }

  // Use getRawBody() (cached in auth.php) since php://input can only be read once
  $raw = getRawBody();

  // Check if the raw body is URL-encoded (contains payload= field)
  if ($raw && strpos($raw, 'payload=') !== false) {
    parse_str($raw, $parsed);
    if (isset($parsed['payload'])) {
      return json_decode($parsed['payload'], true);
    }
  }

  return json_decode($raw, true);
}

/**
 * Append a timestamped line to the update check log.
 * Truncates the log if it exceeds UPDATE_LOG_MAX_BYTES.
 *
 * @param string $message Log message
 */
function logUpdate($message)
{
  $line = '[' . date('Y-m-d H:i:s') . '] ' . $message . "\n";
  file_put_contents(UPDATE_LOG_PATH, $line, FILE_APPEND | LOCK_EX);

  if (file_exists(UPDATE_LOG_PATH) && filesize(UPDATE_LOG_PATH) > UPDATE_LOG_MAX_BYTES) {
    $content = file_get_contents(UPDATE_LOG_PATH);
    $keep = substr($content, -intval(UPDATE_LOG_MAX_BYTES * 0.75));
    $pos = strpos($keep, "\n");
    if ($pos !== false) {
      $keep = substr($keep, $pos + 1);
    }
    file_put_contents(UPDATE_LOG_PATH, $keep, LOCK_EX);
  }
}

/**
 * Check all container images for updates against their registries.
 *
 * Shared logic used by both the cron script and the manual API endpoint.
 * Loads exclude patterns, collects unique images, checks each, and upserts results.
 *
 * @param DockerClient $dockerClient Docker API client
 * @param Database $db Database instance
 * @param callable $log Logging callback: function(string $message)
 * @return array ['results' => [...], 'checked' => int, 'skipped' => int, 'errors' => int, 'newUpdates' => int]
 */
function checkAllImageUpdates($dockerClient, $db, callable $log)
{
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

  $log('INFO Found ' . count($containers) . ' container(s), ' . count($uniqueImages) . ' unique image(s)');

  $results = [];
  $checked = 0;
  $skipped = 0;
  $errors = 0;
  $newUpdates = 0;

  foreach ($uniqueImages as $imageName => $imageId) {
    // Skip excluded images
    $excluded = false;
    foreach ($excludePatterns as $pattern) {
      if (fnmatch($pattern, $imageName)) {
        $excluded = true;
        break;
      }
    }
    if ($excluded) {
      $log('SKIP ' . $imageName . ' (excluded)');
      $skipped++;
      continue;
    }

    // Wrap each image check in try/catch so one failure doesn't kill the loop
    try {
      $check = $dockerClient->checkImageUpdate($imageName, $imageId);
      $checked++;

      // Suppress false positives: if we previously marked this image as
      // up-to-date (e.g. after a pull) and the remote digest hasn't changed,
      // the image is still current. This handles multi-arch images where
      // local RepoDigest format differs from distribution API digest.
      if ($check['update_available'] && !$check['error'] && $check['remote_digest']) {
        $existing = $db->fetchOne(
          'SELECT remote_digest, update_available FROM image_update_checks WHERE image = ?',
          [$imageName]
        );
        if ($existing
            && $existing['update_available'] == 0
            && $existing['remote_digest']
            && $existing['remote_digest'] === $check['remote_digest']) {
          $check['update_available'] = false;
          $log('OK ' . $imageName . ': remote digest unchanged since last pull, no update');
        }
      }

      if ($check['error']) {
        $log('ERROR ' . $imageName . ': ' . $check['error']);
        $errors++;
      } elseif ($check['update_available']) {
        $log('UPDATE ' . $imageName . ': update available');
        $newUpdates++;
      } else {
        $log('OK ' . $imageName . ': up to date');
      }

      // Upsert into database
      $db->query(
        'INSERT OR REPLACE INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at, error)
         VALUES (:image, :local_digest, :remote_digest, :update_available, :checked_at, :error)',
        [
          ':image' => $imageName,
          ':local_digest' => $check['local_digest'],
          ':remote_digest' => $check['remote_digest'],
          ':update_available' => $check['update_available'] ? 1 : 0,
          ':checked_at' => time(),
          ':error' => $check['error'],
        ]
      );

      $results[$imageName] = [
        'image' => $imageName,
        'local_digest' => $check['local_digest'],
        'remote_digest' => $check['remote_digest'],
        'update_available' => $check['update_available'],
        'checked_at' => time(),
        'error' => $check['error'],
      ];
    } catch (\Throwable $e) {
      $log('FATAL ' . $imageName . ': ' . $e->getMessage());
      $errors++;
      $checked++;
      $results[$imageName] = [
        'image' => $imageName,
        'local_digest' => null,
        'remote_digest' => null,
        'update_available' => false,
        'checked_at' => time(),
        'error' => $e->getMessage(),
      ];
    }
  }

  return [
    'results' => $results,
    'checked' => $checked,
    'skipped' => $skipped,
    'errors' => $errors,
    'newUpdates' => $newUpdates,
  ];
}

// JSON response helper
function jsonResponse($data, $statusCode = 200)
{
  http_response_code($statusCode);
  header('Content-Type: application/json');
  echo json_encode($data);
  exit();
}

// Error response helper
function errorResponse($message, $statusCode = 500)
{
  jsonResponse(
    [
      'error' => true,
      'message' => $message,
    ],
    $statusCode,
  );
}
