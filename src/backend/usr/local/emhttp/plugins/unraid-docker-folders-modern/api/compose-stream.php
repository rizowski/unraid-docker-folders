<?php
/**
 * Unraid Docker Folders - Compose Stack Streaming API (SSE)
 *
 * Streams docker compose pull + up output line-by-line via Server-Sent Events.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/ComposeManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

$method = $_SERVER['REQUEST_METHOD'];

requireAuth();

if ($method !== 'POST') {
  header('Content-Type: application/json');
  errorResponse('Method not allowed', 405);
}

$action = $_GET['action'] ?? null;
$project = $_GET['project'] ?? null;

if ($action !== 'up' || !$project) {
  header('Content-Type: application/json');
  errorResponse('Missing or invalid action/project', 400);
}

if (!preg_match('/^[a-zA-Z0-9._-]{1,128}$/', $project)) {
  header('Content-Type: application/json');
  errorResponse('Invalid project name', 400);
}

$composeManager = new ComposeManager();
$status = $composeManager->getStatus();
if (!$status['management_enabled']) {
  header('Content-Type: application/json');
  errorResponse('Compose management is disabled', 403);
}

$forceRecreate = !empty($_POST['force_recreate']);

set_time_limit(0);
ignore_user_abort(true);

header('Content-Type: text/event-stream');
header('Cache-Control: no-cache');
header('X-Accel-Buffering: no');
header('Connection: keep-alive');

while (ob_get_level()) {
  ob_end_flush();
}

function sendSSE($event, $data)
{
  echo "event: {$event}\n";
  echo "data: " . json_encode($data) . "\n\n";
  @flush();
}

try {
  sendSSE('status', ['message' => "Starting {$project}..."]);

  $result = $composeManager->stackUpStreaming(
    $project,
    $forceRecreate,
    function ($phase, $message) {
      sendSSE('phase', ['phase' => $phase, 'message' => $message]);
    },
    function ($line, $stream) {
      sendSSE('log', ['line' => $line, 'stream' => $stream]);
    }
  );

  if ($result['success']) {
    try {
      WebSocketPublisher::publish('compose', 'up', ['project' => $project]);
    } catch (\Throwable $e) {
      // non-critical
    }
    sendSSE('complete', [
      'message' => "{$project} started successfully",
      'project' => $project,
    ]);
  } else {
    $err = $result['error'] ?? ('Exit code ' . ($result['exit_code'] ?? '?'));
    sendSSE('error', ['message' => "Failed to start {$project}: {$err}"]);
  }
} catch (\Throwable $e) {
  sendSSE('error', ['message' => $e->getMessage()]);
}

sendSSE('done', ['finished' => true]);
