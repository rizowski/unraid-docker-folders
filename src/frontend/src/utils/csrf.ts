/**
 * CSRF token utility for Unraid API requests.
 *
 * The token is passed from the .page file via iframe query parameter.
 * Unraid's emhttpd validates csrf_token in the POST body (form-encoded),
 * NOT in query parameters. So all state-changing requests must send it
 * as a form field in the request body.
 *
 * For requests with JSON data, we include both csrf_token and a "payload"
 * field containing the JSON string, sent as application/x-www-form-urlencoded.
 * PHP reads the data from $_POST['payload'].
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
 * For POST/PUT/DELETE: sends csrf_token + optional JSON data as
 * application/x-www-form-urlencoded body so emhttpd can validate.
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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}
