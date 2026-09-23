/**
 * Glue between an app entry and the Unraid page that hosts it in an iframe.
 * Shared by the Folders page (main.ts) and the dashboard widget (widget/main.ts).
 */

/**
 * Read a value the host page put on the iframe URL.
 *
 * The page cannot reach into the frame, so everything it wants to hand over
 * rides on the query string: `csrf_token`, `theme`, `backend`, and the `v`
 * cache-busting stamp (see `include/frameSrc.js`). Returns '' when absent,
 * which is also what standalone dev gets.
 */
export function getHostParam(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) || '';
}

/** Apply the Unraid theme CSS variables the host page passed in `?theme=`. */
export function applyThemeParam(): void {
  const themeParam = getHostParam('theme');
  if (!themeParam) return;
  try {
    const vars = JSON.parse(themeParam) as Record<string, string>;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
  } catch {
    // Ignore malformed theme param
  }
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
