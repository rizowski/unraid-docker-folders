<?php
/**
 * Unraid Docker Folders - Authentication
 *
 * CSRF tokens are validated by Unraid's local_prepend.php for POST requests.
 * For PUT/DELETE, we validate manually against the system token from var.ini.
 *
 * @package UnraidDockerModern
 */

/**
 * Validate that the user has a valid Unraid session
 *
 * @return bool True if session is valid
 */
function validateSession()
{
  // Start session if not already started
  if (session_status() === PHP_SESSION_NONE) {
    session_start();
  }

  // Check if user is logged in to Unraid
  // Unraid sets $_SESSION['csrf_token'] when user is authenticated
  if (!isset($_SESSION['csrf_token'])) {
    return false;
  }

  return true;
}

/**
 * Get the system CSRF token from Unraid's var.ini.
 * This is the same token that local_prepend.php validates against.
 *
 * @return string|null The system CSRF token
 */
function getSystemCsrfToken()
{
  $varIni = '/var/local/emhttp/var.ini';
  if (!file_exists($varIni)) {
    return null;
  }
  $var = parse_ini_file($varIni);
  return $var['csrf_token'] ?? null;
}

/**
 * Validate CSRF token for PUT/DELETE requests.
 *
 * POST requests are already validated by Unraid's local_prepend.php
 * (auto-prepended to all PHP via php.ini). We only need to handle
 * PUT and DELETE ourselves.
 *
 * @return bool True if CSRF token is valid
 */
function validateCsrfToken()
{
  $method = $_SERVER['REQUEST_METHOD'];

  // GET and OPTIONS don't need CSRF validation
  if (in_array($method, ['GET', 'OPTIONS'])) {
    return true;
  }

  // POST is validated by local_prepend.php before our code runs
  if ($method === 'POST') {
    return true;
  }

  // PUT/DELETE: validate manually against the system token
  $systemToken = getSystemCsrfToken();
  if (!$systemToken) {
    return false;
  }

  // Accept token from X-CSRF-Token header or query string
  $token = $_SERVER['HTTP_X_CSRF_TOKEN']
    ?? $_GET['csrf_token']
    ?? null;

  if ($token === null) {
    return false;
  }

  return hash_equals($systemToken, $token);
}

/**
 * Require authentication for API endpoint
 * Exits with 401 if not authenticated
 */
function requireAuth()
{
  if (!validateSession()) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode([
      'error' => true,
      'message' => 'Unauthorized - Please log in to Unraid',
    ]);
    exit();
  }
}

/**
 * Require CSRF validation for API endpoint
 * Exits with 403 if CSRF token is invalid
 */
function requireCsrf()
{
  if (!validateCsrfToken()) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode([
      'error' => true,
      'message' => 'Invalid CSRF token',
    ]);
    exit();
  }
}
