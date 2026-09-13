/**
 * localStorage can be unavailable or throw in several real situations, not
 * just test environments: Safari private browsing throws on access, some
 * browser extensions and enterprise policies block storage entirely, and
 * `window.localStorage` can simply be `undefined` in embedded/iframe
 * contexts with restrictive storage partitioning. These wrappers make every
 * read/write a no-op instead of crashing the component that uses it — a
 * preference silently not persisting is fine; an unmountable page is not.
 */
export function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Storage unavailable or quota exceeded — the preference just won't persist.
  }
}
