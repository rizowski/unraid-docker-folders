/**
 * CSRF token utility for Unraid API requests.
 *
 * When running inside Unraid's page framework (no iframe), the global
 * `var csrf_token` is injected by HeadInlineJS.php. This is the system-wide
 * token from state/var.ini that local_prepend.php validates for all POST requests.
 *
 * Unraid's jQuery $.ajaxPrefilter auto-appends csrf_token to all $.post() calls,
 * but since we use fetch() (not jQuery), we handle it ourselves.
 *
 * local_prepend.php accepts the token from:
 *   - $_POST['csrf_token'] (form-encoded body field)
 *   - $_SERVER['HTTP_X_CSRF_TOKEN'] (X-CSRF-Token header)
 *
 * We send it as a form-encoded POST field alongside a JSON "payload" field,
 * matching the pattern Unraid plugins use.
 */

declare global {
  // eslint-disable-next-line no-var
  var csrf_token: string | undefined;
}

export function getCsrfToken(): string {
  // Primary: Unraid's global variable (injected by HeadInlineJS.php)
  if (typeof window.csrf_token === 'string' && window.csrf_token) {
    return window.csrf_token;
  }

  // Fallback: query parameter (for standalone/dev mode)
  const params = new URLSearchParams(window.location.search);
  return params.get('csrf_token') || '';
}

/**
 * Perform an API fetch with CSRF token handling.
 *
 * For GET requests: passes through as-is.
 * For POST/PUT/DELETE: sends csrf_token as form-encoded field alongside
 * the JSON data in a "payload" field. This ensures local_prepend.php
 * finds the token in $_POST['csrf_token'].
 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();

  if (method === 'GET') {
    return fetch(url, options);
  }

  const token = getCsrfToken();
  const body = new URLSearchParams();

  if (token) {
    body.append('csrf_token', token);
  }

  // If there was a JSON body, move it into a "payload" form field
  if (options.body && typeof options.body === 'string') {
    body.append('payload', options.body);
  }

  return fetch(url, {
    ...options,
    method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}
