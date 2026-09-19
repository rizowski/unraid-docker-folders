/**
 * WebSocket composable for real-time updates via Unraid's nchan server.
 *
 * Singleton — call initWebSocket() once from App.vue.
 * Reconnects with exponential backoff. Includes 30s polling fallback
 * to catch external changes (CLI, Portainer, etc.), paused while the tab is hidden.
 */

import { ref } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useComposeStore } from '@/stores/compose';
import { useUpdatesStore } from '@/stores/updates';
import { useScheduleStore } from '@/stores/schedules';
import { useSettingsStore } from '@/stores/settings';
import type { ConnectionStatus, WebSocketEvent } from '@/types/websocket';

const connectionStatus = ref<ConnectionStatus>('disconnected');

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempt = 0;
let initialized = false;
const DEFAULT_POLL_INTERVAL = 30000;
let pollInterval = DEFAULT_POLL_INTERVAL;

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/sub/docker-modern`;
}

function handleEvent(event: WebSocketEvent) {
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

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  connectionStatus.value = 'connecting';

  try {
    ws = new WebSocket(getWebSocketUrl());
  } catch {
    connectionStatus.value = 'error';
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connectionStatus.value = 'connected';
    reconnectAttempt = 0;
    startPolling();
  };

  ws.onmessage = (msg) => {
    try {
      const event: WebSocketEvent = JSON.parse(msg.data);
      if (event.type === 'event') {
        handleEvent(event);
      }
    } catch {
      // Ignore malformed messages
    }
  };

  ws.onclose = () => {
    connectionStatus.value = 'disconnected';
    stopPolling();
    scheduleReconnect();
  };

  ws.onerror = () => {
    connectionStatus.value = 'error';
    // onclose will fire after this, which schedules reconnect
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempt), MAX_DELAY);
  reconnectAttempt++;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startPolling() {
  stopPolling();
  // A hidden tab needs no fallback poll. onVisibilityChange restarts it.
  if (document.hidden) return;

  pollTimer = setInterval(() => {
    const dockerStore = useDockerStore();
    dockerStore.fetchContainers();
  }, pollInterval);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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

export function useWebSocket() {
  return { connectionStatus };
}

/**
 * @param options.pollInterval How often the fallback poll refetches containers,
 *   in ms. The fetch also reconciles the database (containers.php list path), so
 *   a page that is left open for hours can ask for a slower poll.
 */
export function initWebSocket(options: { pollInterval?: number } = {}) {
  if (initialized) return;
  initialized = true;
  pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
  document.addEventListener('visibilitychange', onVisibilityChange);
  connect();
}

export function destroyWebSocket() {
  initialized = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopPolling();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.onclose = null; // prevent reconnect on intentional close
    ws.close();
    ws = null;
  }

  connectionStatus.value = 'disconnected';
}
