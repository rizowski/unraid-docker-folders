<?php
/**
 * Unraid Docker Folders - Authentication
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
 * Validate CSRF token for POST/PUT/DELETE requests
 *
 * @return bool True if CSRF token is valid
 */
function validateCsrfToken()
{
  $method = $_SERVER['REQUEST_METHOD'];

  // Only validate for state-changing operations
  if (!in_array($method, ['POST', 'PUT', 'DELETE'])) {
    return true;
  }

  // Get token from request
  $token = null;
  if (isset($_SERVER['HTTP_X_CSRF_TOKEN'])) {
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'];
  } elseif (isset($_POST['csrf_token'])) {
    $token = $_POST['csrf_token'];
  } elseif (isset($_GET['csrf_token'])) {
    $token = $_GET['csrf_token'];
  }

  // Compare with session token
  if (session_status() === PHP_SESSION_NONE) {
    session_start();
  }

  if (!isset($_SESSION['csrf_token']) || $token !== $_SESSION['csrf_token']) {
    return false;
  }

  return true;
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

/**
 * Get CSRF token for current session
 *
 * @return string CSRF token
 */
function getCsrfToken()
{
  if (session_status() === PHP_SESSION_NONE) {
    session_start();
  }

  if (!isset($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
  }

  return $_SESSION['csrf_token'];
}
