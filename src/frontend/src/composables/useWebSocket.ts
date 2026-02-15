/**
 * WebSocket composable for real-time updates via Unraid's nchan server.
 *
 * Singleton — call initWebSocket() once from App.vue.
 * Reconnects with exponential backoff. Includes 30s polling fallback
 * to catch external changes (CLI, Portainer, etc.).
 */

import { ref } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import type { ConnectionStatus, WebSocketEvent } from '@/types/websocket';

const connectionStatus = ref<ConnectionStatus>('disconnected');

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectAttempt = 0;
let initialized = false;

const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const POLL_INTERVAL = 30000;

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

  pollTimer = setInterval(() => {
    const dockerStore = useDockerStore();
    dockerStore.fetchContainers();
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function useWebSocket() {
  return { connectionStatus };
}

export function initWebSocket() {
  if (initialized) return;
  initialized = true;
  connect();
}

export function destroyWebSocket() {
  initialized = false;
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
