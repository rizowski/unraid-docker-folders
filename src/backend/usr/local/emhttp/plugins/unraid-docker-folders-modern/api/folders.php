<?php
/**
 * Unraid Docker Folders - Folders API
 *
 * Endpoints for managing folders and container assignments
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/FolderManager.php';
require_once dirname(__DIR__) . '/classes/WebSocketPublisher.php';

// Set JSON content type
header('Content-Type: application/json');

requireAuth();

$method = $_SERVER['REQUEST_METHOD'];
$folderManager = new FolderManager();

/**
 * Read JSON request data.
 * Checks $_POST['payload'] first (form-encoded alongside csrf_token),
 * then parses php://input as URL-encoded (for PUT/DELETE where PHP
 * doesn't populate $_POST), falls back to raw JSON.
 */
function getRequestData()
{
  if (isset($_POST['payload'])) {
    return json_decode($_POST['payload'], true);
  }

  $raw = file_get_contents('php://input');

  // Check if the raw body is URL-encoded (contains payload= field)
  if (strpos($raw, 'payload=') !== false) {
    parse_str($raw, $parsed);
    if (isset($parsed['payload'])) {
      return json_decode($parsed['payload'], true);
    }
  }

  return json_decode($raw, true);
}

try {
  switch ($method) {
    case 'GET':
      handleGet($folderManager);
      break;

    case 'POST':
      handlePost($folderManager);
      break;

    case 'PUT':
      requireCsrf();
      handlePut($folderManager);
      break;

    case 'DELETE':
      requireCsrf();
      handleDelete($folderManager);
      break;

    case 'OPTIONS':
      // Handle CORS preflight
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Folders API error: ' . $e->getMessage());
  errorResponse($e->getMessage(), 500);
}

/**
 * Handle GET requests
 */
function handleGet($folderManager)
{
  $id = $_GET['id'] ?? null;
  $action = $_GET['action'] ?? null;

  // Get statistics
  if ($action === 'stats') {
    $stats = $folderManager->getStatistics();
    jsonResponse($stats);
  }

  // Export configuration
  if ($action === 'export') {
    $config = $folderManager->exportConfiguration();
    header('Content-Disposition: attachment; filename="docker-folders-export-' . date('Y-m-d') . '.json"');
    jsonResponse($config);
  }

  // Get specific folder
  if ($id) {
    $folder = $folderManager->getFolder($id);

    if ($folder === null) {
      errorResponse('Folder not found', 404);
    }

    jsonResponse(['folder' => $folder]);
  }

  // Get all folders
  $folders = $folderManager->getAllFolders();
  jsonResponse([
    'folders' => $folders,
    'count' => count($folders),
  ]);
}

/**
 * Handle POST requests (create folder, add container, reorder)
 */
function handlePost($folderManager)
{
  $action = $_GET['action'] ?? 'create';
  $id = $_GET['id'] ?? null;

  // Import configuration
  if ($action === 'import') {
    $config = getRequestData();

    if (!$config) {
      errorResponse('Invalid JSON data', 400);
    }

    $result = $folderManager->importConfiguration($config);

    if (!$result['success']) {
      errorResponse('Import failed: ' . implode(', ', $result['errors']), 500);
    }

    WebSocketPublisher::publish('folder', 'import', $result);

    jsonResponse($result);
  }

  // Add container to folder
  if ($action === 'add_container') {
    if (!$id) {
      errorResponse('Folder ID is required', 400);
    }

    $data = getRequestData();

    if (!isset($data['container_id']) || !isset($data['container_name'])) {
      errorResponse('container_id and container_name are required', 400);
    }

    $success = $folderManager->addContainerToFolder($id, $data['container_id'], $data['container_name']);

    if (!$success) {
      errorResponse('Failed to add container to folder', 500);
    }

    $folder = $folderManager->getFolder($id);

    WebSocketPublisher::publish('folder', 'add_container', ['folder' => $folder]);

    jsonResponse([
      'success' => true,
      'folder' => $folder,
    ]);
  }

  // Remove container from folder
  if ($action === 'remove_container') {
    $data = getRequestData();

    // Support both container_name (preferred) and container_id (legacy)
    $containerName = $data['container_name'] ?? $data['container_id'] ?? null;
    if (!$containerName) {
      errorResponse('container_name is required', 400);
    }

    $success = $folderManager->removeContainerFromFolder($containerName);

    WebSocketPublisher::publish('folder', 'remove_container', [
      'container_name' => $containerName,
    ]);

    jsonResponse([
      'success' => $success,
    ]);
  }

  // Reorder containers within folder
  if ($action === 'reorder_containers') {
    if (!$id) {
      errorResponse('Folder ID is required', 400);
    }

    $data = getRequestData();

    if (!isset($data['container_ids']) || !is_array($data['container_ids'])) {
      errorResponse('container_ids array is required', 400);
    }

    $success = $folderManager->reorderContainers($id, $data['container_ids']);

    if (!$success) {
      errorResponse('Failed to reorder containers', 500);
    }

    $folder = $folderManager->getFolder($id);

    WebSocketPublisher::publish('folder', 'reorder_containers', ['folder' => $folder]);

    jsonResponse([
      'success' => true,
      'folder' => $folder,
    ]);
  }

  // Reorder folders
  if ($action === 'reorder_folders') {
    $data = getRequestData();

    if (!isset($data['folder_ids']) || !is_array($data['folder_ids'])) {
      errorResponse('folder_ids array is required', 400);
    }

    $success = $folderManager->reorderFolders($data['folder_ids']);

    if (!$success) {
      errorResponse('Failed to reorder folders', 500);
    }

    WebSocketPublisher::publish('folder', 'reorder', null);

    jsonResponse(['success' => true]);
  }

  // Create folder (default action)
  $data = getRequestData();

  if (!$data) {
    $data = [];
  }

  $folder = $folderManager->createFolder($data);

  WebSocketPublisher::publish('folder', 'create', ['folder' => $folder]);

  jsonResponse(
    [
      'success' => true,
      'folder' => $folder,
    ],
    201,
  );
}

/**
 * Handle PUT requests (update folder)
 */
function handlePut($folderManager)
{
  $id = $_GET['id'] ?? null;

  if (!$id) {
    errorResponse('Folder ID is required', 400);
  }

  $data = getRequestData();

  if (!$data) {
    errorResponse('Invalid JSON data', 400);
  }

  $folder = $folderManager->updateFolder($id, $data);

  if ($folder === null) {
    errorResponse('Folder not found', 404);
  }

  WebSocketPublisher::publish('folder', 'update', ['folder' => $folder]);

  jsonResponse([
    'success' => true,
    'folder' => $folder,
  ]);
}

/**
 * Handle DELETE requests (delete folder)
 */
function handleDelete($folderManager)
{
  $id = $_GET['id'] ?? null;

  if (!$id) {
    errorResponse('Folder ID is required', 400);
  }

  $success = $folderManager->deleteFolder($id);

  if (!$success) {
    errorResponse('Folder not found', 404);
  }

  WebSocketPublisher::publish('folder', 'delete', ['id' => $id]);

  jsonResponse(['success' => true]);
}
