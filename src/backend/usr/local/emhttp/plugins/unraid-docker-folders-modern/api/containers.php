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

  if (!$action) {
    errorResponse('Action is required', 400);
  }

  // Autostart toggle (uses container name, not ID)
  if ($action === 'autostart') {
    $name = $_GET['name'] ?? null;
    if (!$name) {
      errorResponse('Container name is required', 400);
    }
    $data = getRequestData();
    $enabled = !empty($data['enabled']);
    $delay = isset($data['delay']) ? max(0, (int)$data['delay']) : null;

    // Update Unraid's autostart flat file (authoritative source)
    $autostartFile = '/var/lib/docker/unraid-autostart';
    $autostartNames = [];
    if (file_exists($autostartFile)) {
      $lines = @file($autostartFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
      if ($lines) $autostartNames = array_map('trim', $lines);
    }

    if ($enabled && !in_array($name, $autostartNames)) {
      $autostartNames[] = $name;
    } elseif (!$enabled) {
      $autostartNames = array_filter($autostartNames, function($n) use ($name) { return $n !== $name; });
    }

    if (@file_put_contents($autostartFile, implode(PHP_EOL, $autostartNames) . PHP_EOL) === false) {
      errorResponse('Failed to update autostart file', 500);
    }

    // Update AutostartDelay in XML template if delay provided
    if ($delay !== null) {
      $templateDir = '/boot/config/plugins/dockerMan/templates-user';
      $xmlPath = $templateDir . '/my-' . $name . '.xml';
      if (!file_exists($xmlPath)) {
        // Scan for matching <Name> element
        $files = @glob($templateDir . '/my-*.xml');
        if ($files) {
          foreach ($files as $f) {
            if (substr($f, -4) === '.bak') continue;
            $content = @file_get_contents($f);
            if ($content && preg_match('/<Name>([^<]+)<\/Name>/', $content, $nm) && trim($nm[1]) === $name) {
              $xmlPath = $f;
              break;
            }
          }
        }
      }

      if (file_exists($xmlPath)) {
        $doc = new DOMDocument();
        $doc->preserveWhiteSpace = true;
        $doc->formatOutput = false;
        if (@$doc->loadXML(@file_get_contents($xmlPath))) {
          $delayNodes = $doc->getElementsByTagName('AutostartDelay');
          if ($delayNodes->length > 0) {
            $delayNodes->item(0)->nodeValue = (string)$delay;
          } else {
            $doc->documentElement->appendChild($doc->createElement('AutostartDelay', (string)$delay));
          }
          @$doc->save($xmlPath);
        }
      }
    }

    jsonResponse(['success' => true, 'autostart' => $enabled, 'autostartDelay' => $delay]);
  }

  if (!$id) {
    errorResponse('Container ID is required', 400);
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
