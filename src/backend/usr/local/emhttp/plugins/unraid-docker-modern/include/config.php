<?php
/**
 * Unraid Docker Modern - Configuration
 *
 * @package UnraidDockerModern
 */

// Plugin information
define('PLUGIN_NAME', 'unraid-docker-folders-modern');
define('PLUGIN_VERSION', '1.0.0');
define('PLUGIN_AUTHOR', 'rizowski');

// Paths
define('PLUGIN_DIR', '/usr/local/emhttp/plugins/' . PLUGIN_NAME);
define('CONFIG_DIR', '/boot/config/plugins/' . PLUGIN_NAME);
define('DATA_DIR', CONFIG_DIR . '/data');
define('BACKUP_DIR', CONFIG_DIR . '/backups');

// Database
define('DB_PATH', CONFIG_DIR . '/data.db');

// Docker
define('DOCKER_SOCKET', '/var/run/docker.sock');
define('DOCKER_API_VERSION', 'v1.41');

// nchan WebSocket
define('NCHAN_PUB_URL', 'http://localhost:4433/pub/docker-modern');
define('NCHAN_SUB_PATH', '/sub/docker-modern');

// Error reporting (disable in production)
if (defined('DEBUG') && DEBUG) {
  error_reporting(E_ALL);
  ini_set('display_errors', '1');
} else {
  error_reporting(0);
  ini_set('display_errors', '0');
}

// Timezone
date_default_timezone_set('UTC');

// CORS headers for API (if needed)
function setCorsHeaders()
{
  // Only allow same-origin for security
  header('Access-Control-Allow-Origin: ' . $_SERVER['HTTP_ORIGIN'] ?? '*');
  header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type, Authorization');
  header('Access-Control-Allow-Credentials: true');
}

// JSON response helper
function jsonResponse($data, $statusCode = 200)
{
  http_response_code($statusCode);
  header('Content-Type: application/json');
  echo json_encode($data);
  exit();
}

// Error response helper
function errorResponse($message, $statusCode = 500)
{
  jsonResponse(
    [
      'error' => true,
      'message' => $message,
    ],
    $statusCode,
  );
}
