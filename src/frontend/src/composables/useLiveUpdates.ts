/**
 * Live updates, over whichever transport the active backend uses.
 *
 * Singleton — call `initLiveUpdates()` once, after `initBackend()` has
 * resolved.
 *
 * Two transports, one dispatch table. nchan is Unraid's own pub/sub and is
 * what the PHP backend publishes to. The GraphQL subscription is the plugin's,
 * and it carries something nchan never did: Docker's own event stream, so a
 * container started from the Unraid webgui, from the command line, or by its
 * own restart policy shows up at once instead of on the next poll.
 *
 * Each mode uses one transport. In GraphQL mode every write goes through the
 * plugin, which publishes on its subscription (and to nchan as well, for a tab
 * still in PHP mode), and PHP's schedule and update runners stand down while
 * the plugin runs them. So nchan carries nothing a GraphQL-mode page needs,
 * and it is not opened. The fallback poll covers what neither announces.
 *
 * `connectionStatus` follows the active mode's transport: in PHP mode nchan,
 * in GraphQL mode the subscription.
 */

import { ref } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useComposeStore } from '@/stores/compose';
import { useUpdatesStore } from '@/stores/updates';
import { useScheduleStore } from '@/stores/schedules';
import { useSettingsStore } from '@/stores/settings';
import { useBackend } from '@/backends';
import { getCsrfToken } from '@/utils/csrf';
import { GraphqlWsClient } from '@/utils/graphqlWs';
import type { BackendMode } from '@/backends/types';
import type { ConnectionStatus, WebSocketEvent } from '@/types/websocket';

const connectionStatus = ref<ConnectionStatus>('disconnected');

const DEFAULT_POLL_INTERVAL = 30000;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

let mode: BackendMode = 'php';
let initialized = false;
let pollInterval = DEFAULT_POLL_INTERVAL;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** The plugin's channel. `entity` and `action` mirror the nchan payload. */
const EVENTS_SUBSCRIPTION = `
  subscription DockerFoldersEvents {
    dockerFoldersEvents {
      entity
      action
      timestamp
    }
  }
`;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function handleEvent(event: Pick<WebSocketEvent, 'entity'>) {
  const dockerStore = useDockerStore();
  const folderStore = useFolderStore();

  if (event.entity === 'container') {
    dockerStore.fetchContainers();
  } else if (event.entity === 'folder') {
    folderStore.fetchFolders();
  } else if (event.entity === 'compose') {
    const composeStore = useComposeStore();
    composeStore.fetchStacks();
    // Compose changes often affect container state too
    dockerStore.fetchContainers();
  } else if (event.entity === 'schedules') {
    const scheduleStore = useScheduleStore();
    scheduleStore.fetchSchedules();
  } else if (event.entity === 'updates') {
    const settingsStore = useSettingsStore();
    if (settingsStore.enableUpdateChecks) {
      const updatesStore = useUpdatesStore();
      updatesStore.fetchCachedUpdates();
    }
  }
}

/**
 * One backoff policy, shared by both transports.
 *
 * Each keeps its own attempt count and timer, because they fail
 * independently: Docker restarting takes the subscription down while nchan
 * stays up, and an nginx reload does the reverse.
 */
class Backoff {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  schedule(work: () => void): void {
    if (this.timer !== null) return;

    const delay = Math.min(BASE_DELAY * Math.pow(2, this.attempt), MAX_DELAY);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      work();
    }, delay);
  }

  reset(): void {
    this.attempt = 0;
  }

  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// nchan
// ---------------------------------------------------------------------------

let nchanSocket: WebSocket | null = null;
const nchanBackoff = new Backoff();

function nchanUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/sub/docker-modern`;
}

function setPrimaryStatus(status: ConnectionStatus, transport: BackendMode): void {
  if (transport === mode) connectionStatus.value = status;
}

function connectNchan(): void {
  if (
    nchanSocket &&
    (nchanSocket.readyState === WebSocket.CONNECTING || nchanSocket.readyState === WebSocket.OPEN)
  ) {
    return;
  }

  setPrimaryStatus('connecting', 'php');

  try {
    nchanSocket = new WebSocket(nchanUrl());
  } catch {
    setPrimaryStatus('error', 'php');
    nchanBackoff.schedule(connectNchan);
    return;
  }

  nchanSocket.onopen = () => {
    setPrimaryStatus('connected', 'php');
    nchanBackoff.reset();
    startPolling();
  };

  nchanSocket.onmessage = (msg) => {
    try {
      const event: WebSocketEvent = JSON.parse(msg.data);
      if (event.type === 'event') handleEvent(event);
    } catch {
      // Ignore malformed messages
    }
  };

  nchanSocket.onclose = () => {
    setPrimaryStatus('disconnected', 'php');
    if (mode === 'php') stopPolling();
    nchanBackoff.schedule(connectNchan);
  };

  nchanSocket.onerror = () => {
    setPrimaryStatus('error', 'php');
    // onclose fires after this and schedules the reconnect.
  };
}

function closeNchan(): void {
  nchanBackoff.cancel();
  if (nchanSocket === null) return;

  nchanSocket.onclose = null; // no reconnect on an intentional close
  nchanSocket.close();
  nchanSocket = null;
}

// ---------------------------------------------------------------------------
// GraphQL subscription
// ---------------------------------------------------------------------------

let gqlClient: GraphqlWsClient | null = null;
const gqlBackoff = new Backoff();

function graphqlUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/graphql`;
}

function connectGraphql(): void {
  if (gqlClient !== null) return;

  setPrimaryStatus('connecting', 'graphql');

  const client = new GraphqlWsClient(
    graphqlUrl(),
    { 'x-csrf-token': getCsrfToken() },
    {
      onReady: () => {
        // The handshake is the only positive signal the protocol offers: a
        // successful `subscribe` is answered with silence until something
        // happens, and on a quiet server that is a long time. Waiting for data
        // would leave the header on "connecting" indefinitely and would keep
        // onVisibilityChange from ever restarting the poll, which checks for
        // "connected". A subscription the guard rejects answers with an error
        // for that id a moment later, and `onError` moves the status then.
        setPrimaryStatus('connected', 'graphql');
        gqlBackoff.reset();
        startPolling();
      },
      onClosed: (reason) => {
        gqlClient = null;
        setPrimaryStatus('disconnected', 'graphql');
        if (mode === 'graphql') stopPolling();
        console.warn(`Live updates disconnected: ${reason}`);
        gqlBackoff.schedule(connectGraphql);
      },
    },
  );

  client.subscribe({
    query: EVENTS_SUBSCRIPTION,
    onData: (data) => {
      const event = (data as { dockerFoldersEvents?: Pick<WebSocketEvent, 'entity'> })
        .dockerFoldersEvents;
      if (event?.entity === undefined) return;

      // Data after an error means the socket recovered without reconnecting.
      setPrimaryStatus('connected', 'graphql');
      handleEvent(event);
    },
    onError: (message) => {
      setPrimaryStatus('error', 'graphql');
      console.warn(`Live updates rejected: ${message}`);
    },
  });

  gqlClient = client;
  client.connect();
}

function closeGraphql(): void {
  gqlBackoff.cancel();
  gqlClient?.close();
  gqlClient = null;
}

// ---------------------------------------------------------------------------
// Polling fallback
// ---------------------------------------------------------------------------

function startPolling() {
  stopPolling();
  // A hidden tab needs no fallback poll. onVisibilityChange restarts it.
  if (document.hidden) return;

  pollTimer = setInterval(() => {
    useDockerStore().fetchContainers();
  }, pollInterval);
}

function stopPolling() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// The poll GET also writes to the database, so skip it while nobody can see the
// page, and catch up once the page is visible again.
function onVisibilityChange() {
  if (document.hidden) {
    stopPolling();
  } else if (connectionStatus.value === 'connected') {
    useDockerStore().fetchContainers();
    startPolling();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function useLiveUpdates() {
  return { connectionStatus };
}

/**
 * @param options.pollInterval How often the fallback poll refetches containers,
 *   in ms. The fetch also reconciles the database (the `containers.php` list
 *   path), so a page left open for hours can ask for a slower poll.
 */
export function initLiveUpdates(options: { pollInterval?: number } = {}) {
  if (initialized) return;
  initialized = true;
  pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
  // The backend that was actually selected, not the one the page asked for.
  // `initBackend()` falls back to PHP when the probe fails, and opening a
  // subscription against a plugin that did not answer would retry forever.
  mode = useBackend().kind;

  document.addEventListener('visibilitychange', onVisibilityChange);

  if (mode === 'graphql') connectGraphql();
  else connectNchan();
}

export function destroyLiveUpdates() {
  initialized = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopPolling();
  closeNchan();
  closeGraphql();
  connectionStatus.value = 'disconnected';
}
