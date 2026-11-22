/**
 * Glue between an app entry and the Unraid page that hosts it in an iframe.
 * Shared by the Folders page (main.ts) and the dashboard widget (widget/main.ts).
 */

/**
 * Read a value the host page put on the iframe URL.
 *
 * The page cannot reach into the frame, so everything it wants to hand over
 * rides on the query string: `csrf_token`, `theme`, `backend`, and the `v`
 * cache-busting stamp (see `include/frameSrc.js`). The theme is also sent again by
 * message when it changes (`listenForThemeUpdates`). Returns '' when absent,
 * which is also what standalone dev gets.
 */
export function getHostParam(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) || '';
}

/**
 * The theme variables the host page may set. Keep in step with DFM_THEME_VARS in
 * `include/frameSrc.js`. A message can only ever touch these names.
 */
export const THEME_VARS: readonly string[] = [
  '--text-color', '--background-color', '--border-color',
  '--header-background', '--header-text-color',
  '--button-background', '--button-hover', '--button-text-color',
  '--input-background', '--input-border',
];

const MAX_THEME_VALUE_LENGTH = 200;

/**
 * Keep only known variable names with short string values. Anything else is
 * dropped, so neither the URL nor a message can set an arbitrary property.
 */
export function sanitizeTheme(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const source = input as Record<string, unknown>;
  for (const key of THEME_VARS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= MAX_THEME_VALUE_LENGTH) out[key] = trimmed;
  }
  return out;
}

/**
 * Set the sanitized variables on the root. When `replace` is true, a known
 * variable missing from `theme` is removed, so a value the parent no longer
 * defines falls back to the stylesheet default instead of staying stale.
 */
export function applyTheme(theme: unknown, replace = false): void {
  const vars = sanitizeTheme(theme);
  const root = document.documentElement;
  for (const key of THEME_VARS) {
    if (key in vars) root.style.setProperty(key, vars[key]);
    else if (replace) root.style.removeProperty(key);
  }
}

/** Apply the Unraid theme CSS variables the host page passed in `?theme=`. */
export function applyThemeParam(): void {
  const themeParam = getHostParam('theme');
  if (!themeParam) return;
  try {
    applyTheme(JSON.parse(themeParam));
  } catch {
    // Ignore malformed theme param
  }
}

/**
 * Follow theme changes the host page sends after load, for a theme that
 * switches in place (a day/night toggle). Accepts only a message from the
 * parent window, from this page's own origin. Returns a function that removes
 * the listener.
 */
export function listenForThemeUpdates(): () => void {
  const onMessage = (event: MessageEvent) => {
    if (window.parent === window) return;
    if (event.origin !== window.location.origin) return;
    if (event.source !== window.parent) return;
    const data = event.data as { type?: unknown; theme?: unknown } | null;
    if (!data || typeof data !== 'object' || data.type !== 'docker-folders-theme') return;
    applyTheme(data.theme, true);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * Tell the host page how tall the iframe must be, whenever the content resizes.
 *
 * Observe the app element (not documentElement) and use offsetHeight (not
 * scrollHeight) so the iframe can shrink when folders collapse — scrollHeight on
 * <html> never decreases because <html> fills the iframe's current (stale) height.
 *
 * `minHeight` lets a caller hold the frame taller than its content for a while,
 * e.g. while a dropdown hangs off the last row. Returns a function that re-sends
 * the height, for when `minHeight`'s answer changes.
 */
export function reportHeightToParent(el: HTMLElement, minHeight: () => number = () => 0): () => void {
  if (window.parent === window) return () => {};
  const sendHeight = () => {
    const height = Math.max(el.offsetHeight, minHeight());
    window.parent.postMessage({ type: 'docker-folders-resize', height }, '*');
  };
  new ResizeObserver(sendHeight).observe(el);
  sendHeight();
  return sendHeight;
}
