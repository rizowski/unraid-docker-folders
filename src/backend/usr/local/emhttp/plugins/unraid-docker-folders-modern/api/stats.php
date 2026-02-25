<?php
/**
 * Unraid Docker Folders - Container Stats API
 *
 * Returns live resource stats (CPU, memory, I/O, etc.) for containers.
 *
 * @package UnraidDockerModern
 */

require_once dirname(__DIR__) . '/include/config.php';
require_once dirname(__DIR__) . '/include/auth.php';
require_once dirname(__DIR__) . '/classes/DockerClient.php';

// Set JSON content type
header('Content-Type: application/json');

requireAuth();

$method = $_SERVER['REQUEST_METHOD'];

try {
  switch ($method) {
    case 'GET':
      handleGet();
      break;

    case 'OPTIONS':
      http_response_code(200);
      exit();

    default:
      errorResponse('Method not allowed', 405);
  }
} catch (Exception $e) {
  error_log('Stats API error: ' . $e->getMessage());
  errorResponse($e->getMessage(), 500);
}

/**
 * Handle GET requests - return stats for requested container IDs
 */
function handleGet()
{
  $idsParam = $_GET['ids'] ?? '';
  if (empty($idsParam)) {
    errorResponse('Missing required parameter: ids', 400);
  }

  $ids = array_filter(array_map('trim', explode(',', $idsParam)));
  if (empty($ids)) {
    errorResponse('No valid container IDs provided', 400);
  }

  $dockerClient = new DockerClient();
  $stats = $dockerClient->fetchBatchStats($ids);

  jsonResponse(['stats' => $stats]);
}
