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
    $stmt = $db->prepare(
      'UPDATE image_update_checks SET update_available = 0, local_digest = remote_digest, checked_at = :now WHERE image = :image'
    );
    $stmt->bindValue(':image', $image, SQLITE3_TEXT);
    $stmt->bindValue(':now', time(), SQLITE3_INTEGER);
    $stmt->execute();

    WebSocketPublisher::publish('updates', 'pulled', ['image' => $image]);
    WebSocketPublisher::publish('container', 'updated');

    sendSSE('complete', ['message' => 'Pull complete', 'image' => $image]);
  } else {
    sendSSE('error', ['message' => 'Pull failed']);
  }
} catch (Exception $e) {
  error_log('Pull API error: ' . $e->getMessage());
  sendSSE('error', ['message' => $e->getMessage()]);
}

sendSSE('done', ['finished' => true]);
