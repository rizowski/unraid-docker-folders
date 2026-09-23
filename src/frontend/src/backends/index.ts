/**
 * Backend selection.
 *
 * The selector lives on the PHP side deliberately: PHP is always present, so
 * the setting is always readable, which avoids storing the backend selector
 * inside the backend being selected.
 *
 * The app runs in an iframe, so a global set by the `.page` belongs to the
 * parent document and is unreachable from here. The mode therefore travels as
 * a query parameter on the frame URL, exactly like `csrf_token` and `theme`
 * (see `include/frameSrc.js`). `window.dockerFoldersBackendMode` is still honored
 * first, for the day the iframe goes away.
 *
 * PHP is the default and anything unrecognized falls back to it. A missing
 * value means an older `.page`, standalone dev, or the widget loaded outside
 * the webgui, and PHP is the safe answer in all three.
 */

import { ref } from 'vue';
import { getHostParam } from '@/utils/iframeHost';
import { graphqlBackend, probeGraphqlBackend } from './graphql';
import { phpBackend } from './php';
import type { Backend, BackendMode } from './types';

declare global {
  interface Window {
    /** Set by the `.page` files. Same name on both sides on purpose. */
    dockerFoldersBackendMode?: string;
  }
}

let active: Backend = phpBackend;

/**
 * Why the app is not on the backend the page asked for. Null when it is, or
 * when PHP was what the page asked for. `BackendNotice.vue` shows it.
 */
export const fallbackReason = ref<string | null>(null);

/** The backend every store calls. */
export function useBackend(): Backend {
  return active;
}

/**
 * Swap the active backend. Used by `initBackend` at boot, by the GraphQL
 * probe when it has to fall back, and by tests.
 */
export function setActiveBackend(next: Backend): void {
  active = next;
}

/** Read the mode the page asked for, defaulting to PHP. */
export function requestedMode(): BackendMode {
  if (typeof window === 'undefined') return 'php';

  const raw = window.dockerFoldersBackendMode || getHostParam('backend');
  return raw === 'graphql' ? 'graphql' : 'php';
}

/**
 * Pick the backend for this session. Await this once, before the app mounts.
 *
 * PHP is chosen without a round trip, so the default path costs nothing. A
 * request for GraphQL is probed first: a plugin can be installed and silently
 * not loaded, and safe mode disables plugin loading outright, so the app has
 * to prove the plugin answers before committing to it. On failure it falls
 * back to PHP and records why, leaving the stored setting alone.
 */
export async function initBackend(): Promise<BackendMode> {
  fallbackReason.value = null;

  if (requestedMode() !== 'graphql') {
    setActiveBackend(phpBackend);
    return 'php';
  }

  const probe = await probeGraphqlBackend();
  if (!probe.ok) {
    console.warn(`GraphQL backend unavailable, using PHP: ${probe.reason}`);
    fallbackReason.value = probe.reason;
    setActiveBackend(phpBackend);
    return 'php';
  }

  setActiveBackend(graphqlBackend);
  return 'graphql';
}

export { phpBackend, graphqlBackend };
export type { Backend, BackendMode, BackendResult } from './types';
