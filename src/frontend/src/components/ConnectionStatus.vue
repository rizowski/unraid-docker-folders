<template>
  <span class="connection-status" :class="connectionStatus">
    <span class="status-dot"></span>
    <span class="status-label">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useWebSocket } from '@/composables/useWebSocket';

const { connectionStatus } = useWebSocket();

const label = computed(() => {
  switch (connectionStatus.value) {
    case 'connected':
      return 'Live';
    case 'connecting':
      return 'Connecting...';
    case 'error':
      return 'Error';
    case 'disconnected':
    default:
      return 'Offline';
  }
});
</script>

<style scoped>
.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  font-weight: 500;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #9e9e9e;
}

.connection-status.connected .status-dot {
  background-color: #4caf50;
}

.connection-status.connecting .status-dot {
  background-color: #ff9800;
  animation: pulse 1.2s ease-in-out infinite;
}

.connection-status.error .status-dot {
  background-color: #f44336;
}

.connection-status.disconnected .status-dot {
  background-color: #9e9e9e;
}

.status-label {
  color: var(--color-text-secondary);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
