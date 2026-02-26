<?php
/**
 * Unraid Docker Folders - Image Pull API (SSE)
 *
 * Pulls a Docker image with real-time progress via Server-Sent Events.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';
require_once dirname(__DIR__) . '/classes/Database.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

$method = $_SERVER['REQUEST_METHOD'];

requireAuth();

if ($method !== 'POST') {
  header('Content-Type: application/json');
  errorResponse('Method not allowed', 405);
}

$image = $_GET['image'] ?? null;

if (!$image) {
  header('Content-Type: application/json');
  errorResponse('Image parameter is required', 400);
}

// Validate image name format
if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]+$/', $image) || strlen($image) > 255) {
  header('Content-Type: application/json');
  errorResponse('Invalid image name', 400);
}

// Allow unlimited execution time — image pulls can take minutes
set_time_limit(0);
ignore_user_abort(true);

// Set SSE headers
header('Content-Type: text/event-stream');
header('Cache-Control: no-cache');
header('X-Accel-Buffering: no');
header('Connection: keep-alive');

// Disable output buffering
while (ob_get_level()) {
  ob_end_flush();
}

function sendSSE($event, $data)
{
  echo "event: {$event}\n";
  echo "data: " . json_encode($data) . "\n\n";
  flush();
}

try {
  $dockerClient = new DockerClient();

  sendSSE('status', ['message' => "Pulling {$image}..."]);

  $success = $dockerClient->pullImage($image, function ($chunk) {
    $event = 'progress';
    $data = [
      'id' => $chunk['id'] ?? '',
      'status' => $chunk['status'] ?? '',
    ];

    if (isset($chunk['progressDetail']) && !empty($chunk['progressDetail'])) {
      $data['current'] = $chunk['progressDetail']['current'] ?? 0;
      $data['total'] = $chunk['progressDetail']['total'] ?? 0;
    }

    if (isset($chunk['error'])) {
      sendSSE('error', ['message' => $chunk['error']]);
      return;
    }

    sendSSE($event, $data);
  });

  if ($success) {
    // Clear update_available flag in database
    $db = Database::getInstance();
    $db->query(
      'UPDATE image_update_checks SET update_available = 0, local_digest = remote_digest, checked_at = :now WHERE image = :image',
      [':image' => $image, ':now' => time()]
    );

    WebSocketPublisher::publish('updates', 'pulled', ['image' => $image]);
    WebSocketPublisher::publish('container', 'updated');

    // Check post_pull_action setting for auto-recreate
    $postPullAction = 'pull_only';
    $row = $db->fetchOne('SELECT value FROM settings WHERE key = ?', ['post_pull_action']);
    if ($row && !empty($row['value'])) {
      $postPullAction = $row['value'];
    }

    if ($postPullAction === 'pull_and_auto_recreate') {
      // Find all containers using this image and recreate them
      $containers = $dockerClient->listContainers(true);
      $matchingContainers = [];
      foreach ($containers as $container) {
        if ($container['image'] === $image) {
          $matchingContainers[] = $container;
        }
      }

      foreach ($matchingContainers as $container) {
        $cName = $container['name'];
        $cId = $container['id'];

        sendSSE('recreating', ['container' => $cName, 'message' => "Recreating {$cName}..."]);

        $recreateResult = $dockerClient->recreateContainer($cId);

        if ($recreateResult['success']) {
          sendSSE('recreated', ['container' => $cName, 'message' => "{$cName} updated successfully"]);
        } else {
          sendSSE('recreate_error', [
            'container' => $cName,
            'message' => "Failed to recreate {$cName}: " . ($recreateResult['error'] ?? 'Unknown error'),
          ]);
        }
      }
    }

    sendSSE('complete', ['message' => 'Pull complete', 'image' => $image]);
  } else {
    sendSSE('error', ['message' => 'Pull failed']);
  }
} catch (Exception $e) {
  error_log('Pull API error: ' . $e->getMessage());
  sendSSE('error', ['message' => $e->getMessage()]);
}

sendSSE('done', ['finished' => true]);
