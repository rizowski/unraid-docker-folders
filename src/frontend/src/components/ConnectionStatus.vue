<template>
  <span class="inline-flex items-center gap-1.5 text-xs font-medium">
    <span
      class="w-2 h-2 rounded-full"
      :class="{
        'bg-success': connectionStatus === 'connected',
        'bg-warning animate-pulse': connectionStatus === 'connecting',
        'bg-error': connectionStatus === 'error',
        'bg-muted': connectionStatus === 'disconnected',
      }"
    ></span>
    <span class="text-text-secondary">{{ label }}</span>
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
