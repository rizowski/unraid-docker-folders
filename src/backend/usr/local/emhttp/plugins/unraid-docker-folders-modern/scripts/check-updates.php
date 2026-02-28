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

// Allow unlimited execution time (CLI default is 0, but be explicit)
set_time_limit(0);

// Exit gracefully if Docker socket is not available
if (!file_exists(DOCKER_SOCKET)) {
  logUpdate('SKIP Docker socket not available');
  exit(0);
}

logUpdate('START Update check begun');

$db = Database::getInstance();
$dockerClient = new DockerClient();

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

$result = checkAllImageUpdates($dockerClient, $db, 'logUpdate');

// Count truly new updates (not previously known)
$newUpdatesCount = 0;
foreach ($result['results'] as $imageName => $info) {
  if ($info['update_available'] && !($previousUpdates[$imageName] ?? false)) {
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
  logUpdate('NOTIFY Sent notification: ' . $newUpdatesCount . ' new update(s)');
}

logUpdate('DONE Checked ' . $result['checked'] . ', skipped ' . $result['skipped'] . ', errors ' . $result['errors'] . ', new updates ' . $newUpdatesCount);

exit(0);
