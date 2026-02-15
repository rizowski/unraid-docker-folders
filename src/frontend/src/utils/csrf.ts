/**
 * CSRF token utility for Unraid API requests.
 *
 * The token is passed from the .page file via iframe query parameter.
 * It originates from Unraid's $var['csrf_token'] (state/var.ini), which is
 * the system-wide token that local_prepend.php validates for all POST requests.
 *
 * We send it via the X-CSRF-Token header, which local_prepend.php accepts
 * alongside $_POST['csrf_token']. This lets us use JSON request bodies
 * instead of form-encoded payloads.
 */

let csrfToken: string | null = null;

export function getCsrfToken(): string | null {
  if (csrfToken === null) {
    const params = new URLSearchParams(window.location.search);
    csrfToken = params.get('csrf_token');
  }
  return csrfToken;
}

/**
 * Perform an API fetch with CSRF token handling.
 *
 * For GET requests: passes through as-is.
 * For POST/PUT/DELETE: sends X-CSRF-Token header + JSON body.
 *
 * Note: Unraid's local_prepend.php only validates POST requests.
 * PUT/DELETE bypass server-level validation but our PHP can validate if needed.
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();

  if (method === 'GET') {
    return fetch(url, options);
  }

  const token = getCsrfToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['X-CSRF-Token'] = token;
  }

  return fetch(url, {
    ...options,
    method,
    headers,
    // body passes through as-is (JSON string from callers)
  });
}
