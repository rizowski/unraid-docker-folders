/**
 * CSRF token utility for Unraid API requests.
 *
 * The token is passed from the .page file via iframe query parameter.
 * All POST/PUT/DELETE requests must include it or Unraid's webGUI
 * will reject them with an empty response.
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
 * Append csrf_token to a URL for state-changing requests.
 */
export function withCsrf(url: string): string {
  const token = getCsrfToken();
  if (!token) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}csrf_token=${encodeURIComponent(token)}`;
}
