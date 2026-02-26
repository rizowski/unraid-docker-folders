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
 * Read and cache php://input so it can be accessed multiple times.
 * PHP only allows reading php://input once per request, so this
 * caches it for both CSRF validation and API request data parsing.
 *
 * @return string The raw request body
 */
function getRawBody($testOverride = null)
{
  static $body = null;
  if ($testOverride !== null) {
    $body = $testOverride;
    return $body;
  }
  if ($body === null) {
    $body = file_get_contents('php://input') ?: '';
  }
  return $body;
}

/**
 * Validate that the user has a valid Unraid session.
 *
 * Unraid uses a PHP session with a custom name like "unraid_<md5hash>".
 * local_prepend.php may or may not start the session for plugin API paths,
 * so we also try to resume the session ourselves from the cookie.
 *
 * @return bool True if session is valid
 */
function validateSession()
{
  // Method 1: PHP session already active (local_prepend.php started it)
  if (session_status() === PHP_SESSION_ACTIVE && !empty($_SESSION['csrf_token'])) {
    return true;
  }

  // Method 2: Resume Unraid PHP session from unraid_* cookie
  // Unraid's session cookie is named "unraid_<32-char md5 hash>".
  // The session file tracks auth state but csrf_token is added at
  // runtime by local_prepend.php (from var.ini), not stored in the file.
  // A non-empty session means the user authenticated via Unraid login.
  if (session_status() !== PHP_SESSION_ACTIVE) {
    foreach ($_COOKIE as $name => $value) {
      if (preg_match('/^unraid_[a-f0-9]{32}$/', $name)) {
        session_name($name);
        session_start(['read_and_close' => true]);
        if (!empty($_SESSION)) {
          return true;
        }
        break;
      }
    }
  }

  // Method 3: Flask-style "session" cookie (older Unraid versions)
  // Format: base64url(json_payload).timestamp.signature
  if (!empty($_COOKIE['session'])) {
    $parts = explode('.', $_COOKIE['session']);
    if (count($parts) >= 2) {
      $payload = base64_decode(strtr($parts[0], '-_', '+/'));
      $data = json_decode($payload, true);
      if (is_array($data) && !empty($data['csrf_token'])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get the system CSRF token from Unraid's var.ini.
 * This is the same token that local_prepend.php validates POST requests against.
 *
 * @return string|null The system CSRF token
 */
function getSystemCsrfToken($varIniPath = null)
{
  $varIni = $varIniPath ?? '/var/local/emhttp/var.ini';
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
 * NOTE: $_GET['csrf_token'] is NOT checked — Unraid does not support
 * CSRF tokens via query parameters.
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

  // Check header first
  $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? null;

  // PHP only populates $_POST for POST requests, not PUT/DELETE.
  // Parse the cached raw body to extract the csrf_token field.
  if ($token === null) {
    $raw = getRawBody();
    if ($raw && strpos($raw, 'csrf_token=') !== false) {
      parse_str($raw, $parsed);
      $token = $parsed['csrf_token'] ?? null;
    }
  }

  if ($token === null) {
    return false;
  }

  return hash_equals($systemToken, $token);
}

/**
 * Require authentication for API endpoint.
 * Exits with 401 if not authenticated.
 *
 * Note: relies on config.php being loaded first (for errorResponse()).
 * All API endpoints load config.php before auth.php, so this is safe.
 */
function requireAuth()
{
  if (!validateSession()) {
    errorResponse('Unauthorized - Please log in to Unraid', 401);
  }
}

/**
 * Require CSRF validation for API endpoint.
 * Exits with 403 if CSRF token is invalid.
 *
 * Note: relies on config.php being loaded first (for errorResponse()).
 */
function requireCsrf()
{
  if (!validateCsrfToken()) {
    errorResponse('Invalid CSRF token', 403);
  }
}
