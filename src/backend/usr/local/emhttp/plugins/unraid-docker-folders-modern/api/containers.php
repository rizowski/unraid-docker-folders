<?php
/**
 * Unraid Docker Folders - Containers API
 *
 * Endpoints for managing Docker containers
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';
require_once dirname(__DIR__) . '/classes/FolderManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

// Set JSON content type
header('Content-Type: application/json');

requireAuth();

$method = $_SERVER['REQUEST_METHOD'];
$dockerClient = new DockerClient();

try {
  switch ($method) {
    case 'GET':
      handleGet($dockerClient);
      break;

    case 'POST':
      handlePost($dockerClient);
      break;

    case 'OPTIONS':
      // Handle CORS preflight
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Containers API error: ' . $e->getMessage());
  errorResponse($e->getMessage(), 500);
}

/**
 * Handle GET requests
 */
function handleGet($dockerClient)
{
  $action = $_GET['action'] ?? null;
  $id = $_GET['id'] ?? null;

  if ($action === 'logs') {
    if (!$id) {
      errorResponse('Container ID is required', 400);
    }
    $tail = isset($_GET['tail']) ? max(1, min(500, (int)$_GET['tail'])) : 50;
    $logs = $dockerClient->getContainerLogs($id, $tail);
    jsonResponse(['logs' => $logs]);
    return;
  }

  if ($id) {
    // Get specific container
    $container = $dockerClient->inspectContainer($id);

    if ($container === null) {
      errorResponse('Container not found', 404);
    }

    jsonResponse([
      'container' => $container,
    ]);
  } else {
    // List all containers
    $containers = $dockerClient->listContainers(true);

    // Reconcile container IDs (handles container recreate/update)
    $folderManager = new FolderManager();
    $folderManager->reconcileContainerIds($containers);

    // Auto-group Docker Compose stacks into folders
    $changed = $folderManager->syncComposeStacks($containers);
    if ($changed) {
      WebSocketPublisher::publish('folders', 'updated');
    }

    jsonResponse([
      'containers' => $containers,
      'count' => count($containers),
      'cached' => false,
    ]);
  }
}

/**
 * Handle POST requests (start, stop, restart, remove)
 */
function handlePost($dockerClient)
{
  $action = $_GET['action'] ?? null;
  $id = $_GET['id'] ?? null;

  if (!$id) {
    errorResponse('Container ID is required', 400);
  }

  if (!$action) {
    errorResponse('Action is required', 400);
  }

  $success = false;
  $message = '';

  switch ($action) {
    case 'start':
      $success = $dockerClient->startContainer($id);
      $message = $success ? 'Container started successfully' : 'Failed to start container';
      break;

    case 'stop':
      $success = $dockerClient->stopContainer($id);
      $message = $success ? 'Container stopped successfully' : 'Failed to stop container';
      break;

    case 'restart':
      $success = $dockerClient->restartContainer($id);
      $message = $success ? 'Container restarted successfully' : 'Failed to restart container';
      break;

    case 'remove':
      $force = isset($_GET['force']) && $_GET['force'] === '1';
      $success = $dockerClient->removeContainer($id, $force);
      $message = $success ? 'Container removed successfully' : 'Failed to remove container';
      break;

    default:
      errorResponse('Invalid action', 400);
  }

  if (!$success) {
    errorResponse($message, 500);
  }

  // Get updated container info (may be null for 'remove')
  $container = $action !== 'remove' ? $dockerClient->inspectContainer($id) : null;

  WebSocketPublisher::publish('container', $action, [
    'id' => $id,
    'container' => $container,
  ]);

  jsonResponse([
    'success' => true,
    'message' => $message,
    'container' => $container,
  ]);
}
