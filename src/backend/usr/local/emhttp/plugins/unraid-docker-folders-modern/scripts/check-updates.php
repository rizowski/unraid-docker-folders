#!/usr/bin/php
<?php
/**
 * Unraid Docker Folders - Background Update Checker (cron)
 *
 * Checks all container images against their registries, upserts results
 * into the database, publishes a WebSocket event, and optionally sends
 * an Unraid notification when new updates are found.
 *
 * Usage: php check-updates.php
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

// Exit gracefully if Docker socket is not available
if (!file_exists(DOCKER_SOCKET)) {
  exit(0);
}

$db = Database::getInstance();
$dockerClient = new DockerClient();

// Load exclude patterns from settings
$excludePatterns = [];
$excludeRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_exclude'");
if ($excludeRow && !empty($excludeRow['value'])) {
  $excludePatterns = array_map('trim', explode(',', $excludeRow['value']));
  $excludePatterns = array_filter($excludePatterns, function ($p) { return $p !== ''; });
}

// Load notification setting
$notifyRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'notify_on_updates'");
$notifyEnabled = $notifyRow && $notifyRow['value'] === '1';

// Snapshot current update_available state before checking
$previousUpdates = [];
$stmt = $db->query('SELECT image, update_available FROM image_update_checks');
if ($stmt) {
  while ($row = $stmt->fetchArray(SQLITE3_ASSOC)) {
    $previousUpdates[$row['image']] = (bool) $row['update_available'];
  }
}

// List all containers
$containers = $dockerClient->listContainers(true);

// Collect unique images
$uniqueImages = [];
foreach ($containers as $container) {
  $image = $container['image'] ?? '';
  $imageId = $container['imageId'] ?? '';
  if ($image && !isset($uniqueImages[$image])) {
    $uniqueImages[$image] = $imageId;
  }
}

// Filter out excluded images
function isExcluded($imageName, $patterns)
{
  foreach ($patterns as $pattern) {
    if (fnmatch($pattern, $imageName)) {
      return true;
    }
  }
  return false;
}

$newUpdatesCount = 0;

foreach ($uniqueImages as $imageName => $imageId) {
  if (isExcluded($imageName, $excludePatterns)) {
    continue;
  }

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

  // Track newly discovered updates (not previously known)
  if ($check['update_available'] && !($previousUpdates[$imageName] ?? false)) {
    $newUpdatesCount++;
  }
}

// Publish WebSocket event so frontends refresh
WebSocketPublisher::publish('updates', 'checked');

// Send Unraid notification if new updates were found
if ($newUpdatesCount > 0 && $notifyEnabled) {
  $s = $newUpdatesCount === 1 ? '' : 's';
  exec("/usr/local/emhttp/webGui/scripts/notify -s 'Docker Folders' -d '{$newUpdatesCount} container update{$s} available' -i normal");
}

exit(0);
