<?php
/**
 * Unraid Docker Folders - Authentication
 *
 * CSRF for POST requests is validated by Unraid's local_prepend.php
 * (auto-prepended via php.ini) against the system token in state/var.ini.
 * For PUT/DELETE, we validate manually.
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
  if (session_status() === PHP_SESSION_NONE) {
    session_start();
  }

  if (!isset($_SESSION['csrf_token'])) {
    return false;
  }

  return true;
}

/**
 * Get the system CSRF token from Unraid's var.ini.
 * This is the same token that local_prepend.php validates POST requests against.
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
 * Validate CSRF token for state-changing requests.
 *
 * POST: Already validated by Unraid's local_prepend.php before our code runs.
 * PUT/DELETE: We validate manually against the system token from var.ini.
 *
 * @return bool True if CSRF token is valid
 */
function validateCsrfToken()
{
  $method = $_SERVER['REQUEST_METHOD'];

  if (in_array($method, ['GET', 'OPTIONS'])) {
    return true;
  }

  // POST is already validated by local_prepend.php
  if ($method === 'POST') {
    return true;
  }

  // PUT/DELETE: validate manually
  $systemToken = getSystemCsrfToken();
  if (!$systemToken) {
    return false;
  }

  $token = $_SERVER['HTTP_X_CSRF_TOKEN']
    ?? $_POST['csrf_token']
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
