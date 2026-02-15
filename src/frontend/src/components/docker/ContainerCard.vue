<template>
  <div class="border border-border rounded-lg p-6 bg-bg-card shadow-sm hover:shadow-md transition cursor-grab active:cursor-grabbing select-none" :data-container-id="container.id">
    <div class="flex items-center gap-2 mb-2">
      <img
        v-if="container.icon"
        :src="container.icon"
        :alt="container.name"
        class="w-8 h-8 object-contain shrink-0"
      />
      <h3 class="flex-1 text-lg font-semibold text-text">{{ container.name }}</h3>
      <span
        class="px-2 py-0.5 rounded-full text-xs font-semibold uppercase"
        :class="{
          'bg-green-100 text-green-800': container.state === 'running',
          'bg-red-100 text-red-800': container.state === 'exited' || container.state === 'stopped',
        }"
      >
        {{ container.state }}
      </span>
    </div>
    <div class="mb-4">
      <p class="my-1 text-sm text-text-secondary font-mono">{{ container.image }}</p>
      <p class="my-1 text-xs text-muted font-mono">{{ container.id.substring(0, 12) }}</p>
    </div>
    <div class="flex gap-2">
      <button
        v-if="container.state === 'running'"
        @click="$emit('stop', container.id)"
        class="flex-1 py-2 px-4 border-none rounded text-sm font-medium cursor-pointer transition bg-error text-white hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
      >
        Stop
      </button>
      <button
        v-else
        @click="$emit('start', container.id)"
        class="flex-1 py-2 px-4 border-none rounded text-sm font-medium cursor-pointer transition bg-success text-white hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
      >
        Start
      </button>
      <button
        @click="$emit('restart', container.id)"
        class="flex-1 py-2 px-4 border-none rounded text-sm font-medium cursor-pointer transition bg-primary text-primary-text hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
      >
        Restart
      </button>
      <button
        v-if="container.state !== 'running'"
        @click="$emit('remove', container.id)"
        class="flex-1 py-2 px-4 border-none rounded text-sm font-medium cursor-pointer transition bg-muted text-white hover:bg-error disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Remove container"
      >
        Remove
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Container } from '@/stores/docker';

interface Props {
  container: Container;
  actionInProgress?: boolean;
}

defineProps<Props>();

defineEmits<{
  start: [id: string];
  stop: [id: string];
  restart: [id: string];
  remove: [id: string];
}>();
</script>
