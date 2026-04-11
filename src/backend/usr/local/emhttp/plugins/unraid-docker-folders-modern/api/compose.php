<?php
/**
 * Unraid Docker Folders - Compose API
 *
 * Endpoints for managing Docker Compose stacks
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/ComposeManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

header('Content-Type: application/json');

requireAuth();

$method = $_SERVER['REQUEST_METHOD'];
$composeManager = new ComposeManager();

try {
  switch ($method) {
    case 'GET':
      handleGet($composeManager);
      break;

    case 'POST':
      handlePost($composeManager);
      break;

    case 'OPTIONS':
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Compose API error: ' . $e->getMessage());
  errorResponse($e->getMessage(), 500);
}

/**
 * Handle GET requests
 */
function handleGet($composeManager)
{
  $action = $_GET['action'] ?? null;
  $project = $_GET['project'] ?? null;

  // Status check (binary available, conflict, etc.)
  if ($action === 'status') {
    jsonResponse($composeManager->getStatus());
  }

  // List all compose stacks
  if ($action === 'list') {
    $stacks = $composeManager->getAllStacks();
    jsonResponse([
      'stacks' => $stacks,
      'count' => count($stacks),
    ]);
  }

  // Get compose file content
  if ($action === 'file' && $project) {
    $result = $composeManager->getComposeFileContent($project);
    if (!$result['success']) {
      errorResponse($result['error'], 404);
    }
    jsonResponse($result);
  }

  // Get env file content
  if ($action === 'env' && $project) {
    $result = $composeManager->getEnvFileContent($project);
    if (!$result['success']) {
      errorResponse($result['error'], 404);
    }
    jsonResponse($result);
  }

  // Get stack logs
  if ($action === 'logs' && $project) {
    $tail = (int) ($_GET['tail'] ?? 100);
    $result = $composeManager->stackLogs($project, $tail);
    jsonResponse($result);
  }

  // Get single stack
  if ($project) {
    $stack = $composeManager->getStack($project);
    if (!$stack) {
      errorResponse('Stack not found', 404);
    }
    jsonResponse(['stack' => $stack]);
  }

  errorResponse('Missing action or project parameter', 400);
}

/**
 * Handle POST requests
 */
function handlePost($composeManager)
{
  $action = $_GET['action'] ?? null;
  $project = $_GET['project'] ?? null;

  // Install docker compose binary
  if ($action === 'install_binary') {
    $result = $composeManager->installComposeBinary();
    if (!$result['success']) {
      errorResponse($result['error'], 500);
    }
    jsonResponse([
      'success' => true,
      'status' => $composeManager->getStatus(),
    ]);
  }

  // Export compose configs to directory
  if ($action === 'export_configs') {
    $db = Database::getInstance();
    $exportDirSetting = $db->fetchOne("SELECT value FROM settings WHERE key = 'compose_export_dir'");
    $exportDir = ($exportDirSetting && !empty($exportDirSetting['value']))
      ? $exportDirSetting['value']
      : COMPOSE_STACKS_DIR;

    $result = $composeManager->exportConfigs($exportDir);
    if (!$result['success']) {
      errorResponse($result['error'], 500);
    }
    jsonResponse($result);
  }

  // Create new stack
  if ($action === 'create') {
    $data = getRequestData();
    $projectName = $data['project_name'] ?? null;
    if (!$projectName) {
      errorResponse('Project name is required', 400);
    }
    $composeContent = $data['compose_content'] ?? '';
    $envContent = $data['env_content'] ?? '';

    $result = $composeManager->createStack($projectName, $composeContent, $envContent);
    if (!$result['success']) {
      errorResponse($result['error'], 400);
    }

    WebSocketPublisher::publish('compose', 'create', ['project' => $projectName]);
    WebSocketPublisher::publish('folders', 'updated');
    jsonResponse($result);
  }

  // Import from compose_plugin
  if ($action === 'import') {
    $result = $composeManager->importFromComposePlugin();

    if ($result['stacks_imported'] > 0) {
      WebSocketPublisher::publish('compose', 'import', $result);
    }

    jsonResponse($result);
  }

  // All remaining actions require a project name
  if (!$project) {
    errorResponse('Project name is required', 400);
  }

  // Check conflict before management operations
  $status = $composeManager->getStatus();

  // Stack up
  if ($action === 'up') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled (compose_plugin may be installed)', 403);
    }

    $data = getRequestData();
    $forceRecreate = !empty($data['force_recreate']);
    $result = $composeManager->stackUp($project, $forceRecreate);

    WebSocketPublisher::publish('compose', 'up', ['project' => $project]);

    jsonResponse($result);
  }

  // Stack down
  if ($action === 'down') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $result = $composeManager->stackDown($project);

    WebSocketPublisher::publish('compose', 'down', ['project' => $project]);

    jsonResponse($result);
  }

  // Stack restart
  if ($action === 'restart') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $result = $composeManager->stackRestart($project);

    WebSocketPublisher::publish('compose', 'restart', ['project' => $project]);

    jsonResponse($result);
  }

  // Validate compose file (docker compose config)
  if ($action === 'validate') {
    $data = getRequestData();
    $content = isset($data['content']) ? $data['content'] : null;
    $result = $composeManager->validateComposeContent($project, $content);
    jsonResponse($result);
  }

  // Stack pull
  if ($action === 'pull') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $result = $composeManager->stackPull($project);

    WebSocketPublisher::publish('compose', 'pull', ['project' => $project]);

    jsonResponse($result);
  }

  // Save compose file
  if ($action === 'save_file') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $data = getRequestData();
    if (!isset($data['content'])) {
      errorResponse('content is required', 400);
    }

    $result = $composeManager->saveComposeFileContent($project, $data['content']);

    if (!$result['success']) {
      errorResponse($result['error'], 500);
    }

    WebSocketPublisher::publish('compose', 'save_file', ['project' => $project]);

    jsonResponse($result);
  }

  // Save env file
  if ($action === 'save_env') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $data = getRequestData();
    if (!isset($data['content'])) {
      errorResponse('content is required', 400);
    }

    $result = $composeManager->saveEnvFileContent($project, $data['content']);

    if (!$result['success']) {
      errorResponse($result['error'], 500);
    }

    WebSocketPublisher::publish('compose', 'save_env', ['project' => $project]);

    jsonResponse($result);
  }

  // Set env file path
  if ($action === 'set_env_path') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $data = getRequestData();
    if (!isset($data['path'])) {
      errorResponse('path is required', 400);
    }

    $composeManager->setEnvFilePath($project, $data['path']);

    WebSocketPublisher::publish('compose', 'set_env_path', ['project' => $project]);

    jsonResponse(['success' => true]);
  }

  // Set autostart
  if ($action === 'autostart') {
    if (!$status['management_enabled']) {
      errorResponse('Compose management is disabled', 403);
    }

    $data = getRequestData();
    $enabled = !empty($data['enabled']);
    $forceRecreate = !empty($data['force_recreate']);

    $composeManager->setAutostart($project, $enabled, $forceRecreate);

    WebSocketPublisher::publish('compose', 'autostart', [
      'project' => $project,
      'enabled' => $enabled,
    ]);

    jsonResponse(['success' => true]);
  }

  // Set description
  if ($action === 'set_description') {
    $data = getRequestData();
    if (!isset($data['description'])) {
      errorResponse('description is required', 400);
    }

    $composeManager->setDescription($project, $data['description']);

    jsonResponse(['success' => true]);
  }

  errorResponse('Unknown action: ' . $action, 400);
}
