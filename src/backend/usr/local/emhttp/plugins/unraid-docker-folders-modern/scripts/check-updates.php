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

/**
 * Append a timestamped line to the update check log.
 * Truncates the log if it exceeds UPDATE_LOG_MAX_BYTES.
 */
function logMessage($message)
{
  $line = '[' . date('Y-m-d H:i:s') . '] ' . $message . "\n";
  file_put_contents(UPDATE_LOG_PATH, $line, FILE_APPEND | LOCK_EX);

  // Truncate if over size limit — keep the tail
  if (file_exists(UPDATE_LOG_PATH) && filesize(UPDATE_LOG_PATH) > UPDATE_LOG_MAX_BYTES) {
    $content = file_get_contents(UPDATE_LOG_PATH);
    $keep = substr($content, -intval(UPDATE_LOG_MAX_BYTES * 0.75));
    // Trim to first complete line
    $pos = strpos($keep, "\n");
    if ($pos !== false) {
      $keep = substr($keep, $pos + 1);
    }
    file_put_contents(UPDATE_LOG_PATH, $keep, LOCK_EX);
  }
}

// Exit gracefully if Docker socket is not available
if (!file_exists(DOCKER_SOCKET)) {
  logMessage('SKIP Docker socket not available');
  exit(0);
}

logMessage('START Update check begun');

$db = Database::getInstance();
$dockerClient = new DockerClient();

// Load exclude patterns from settings
$excludePatterns = [];
$excludeRow = $db->fetchOne("SELECT value FROM settings WHERE key = 'update_check_exclude'");
if ($excludeRow && !empty($excludeRow['value'])) {
  $excludePatterns = array_map('trim', explode(',', $excludeRow['value']));
  $excludePatterns = array_filter($excludePatterns, function ($p) { return $p !== ''; });
}

if (count($excludePatterns) > 0) {
  logMessage('INFO Exclude patterns: ' . implode(', ', $excludePatterns));
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
logMessage('INFO Found ' . count($containers) . ' container(s)');

// Collect unique images
$uniqueImages = [];
foreach ($containers as $container) {
  $image = $container['image'] ?? '';
  $imageId = $container['imageId'] ?? '';
  if ($image && !isset($uniqueImages[$image])) {
    $uniqueImages[$image] = $imageId;
  }
}

logMessage('INFO ' . count($uniqueImages) . ' unique image(s) to check');

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
$checkedCount = 0;
$skippedCount = 0;
$errorCount = 0;

foreach ($uniqueImages as $imageName => $imageId) {
  if (isExcluded($imageName, $excludePatterns)) {
    logMessage('SKIP ' . $imageName . ' (excluded)');
    $skippedCount++;
    continue;
  }

  $check = $dockerClient->checkImageUpdate($imageName, $imageId);
  $checkedCount++;

  if ($check['error']) {
    logMessage('ERROR ' . $imageName . ': ' . $check['error']);
    $errorCount++;
  } elseif ($check['update_available']) {
    logMessage('UPDATE ' . $imageName . ': update available');
  } else {
    logMessage('OK ' . $imageName . ': up to date');
  }

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
  $msg = escapeshellarg("{$newUpdatesCount} container update{$s} available");
  exec("/usr/local/emhttp/webGui/scripts/notify -s 'Docker Folders' -d {$msg} -i normal");
  logMessage('NOTIFY Sent notification: ' . $newUpdatesCount . ' new update(s)');
}

logMessage('DONE Checked ' . $checkedCount . ', skipped ' . $skippedCount . ', errors ' . $errorCount . ', new updates ' . $newUpdatesCount);

exit(0);
