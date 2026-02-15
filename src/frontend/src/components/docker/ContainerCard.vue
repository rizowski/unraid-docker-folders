<template>
  <!-- Grid (card) view -->
  <div v-if="view === 'grid'" class="border border-border rounded-lg p-6 bg-bg-card shadow-sm hover:shadow-md transition" :data-container-id="container.id">
    <div class="flex items-center gap-2 mb-2">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing"
      >
        <circle cx="9" cy="5" r="1" />
        <circle cx="9" cy="12" r="1" />
        <circle cx="9" cy="19" r="1" />
        <circle cx="15" cy="5" r="1" />
        <circle cx="15" cy="12" r="1" />
        <circle cx="15" cy="19" r="1" />
      </svg>
      <img v-if="container.icon" :src="container.icon" :alt="container.name" class="w-10 h-10 object-contain shrink-0" />
      <h3 class="flex-1 text-lg font-semibold text-text">{{ container.name }}</h3>
      <span class="px-2 py-0.5 rounded-full text-xs font-semibold uppercase" :class="statusClasses">
        {{ container.state }}
      </span>
      <a
        v-if="editUrl"
        :href="editUrl"
        class="shrink-0 text-text-secondary hover:text-text transition"
        title="Edit container"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </a>
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

  <!-- List view -->
  <div v-else class="flex items-center gap-4 px-4 py-3 bg-bg-card border border-border rounded hover:shadow-sm transition" :data-container-id="container.id">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing -mr-2"
    >
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
    <img v-if="container.icon" :src="container.icon" :alt="container.name" class="w-6 h-6 object-contain shrink-0" />
    <span class="font-semibold text-text min-w-[140px]">{{ container.name }}</span>
    <span class="px-2 py-0.5 rounded-full text-xs font-semibold uppercase shrink-0" :class="statusClasses">
      {{ container.state }}
    </span>
    <span class="text-sm text-text-secondary font-mono truncate hidden sm:inline">{{ container.image }}</span>
    <span class="text-xs text-muted font-mono hidden md:inline">{{ container.id.substring(0, 12) }}</span>
    <div class="flex gap-1.5 ml-auto shrink-0 items-center">
      <a
        v-if="editUrl"
        :href="editUrl"
        class="text-text-secondary hover:text-text transition p-1"
        title="Edit container"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </a>
      <button
        v-if="container.state === 'running'"
        @click="$emit('stop', container.id)"
        class="py-1 px-3 border-none rounded text-xs font-medium cursor-pointer transition bg-error text-white hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
      >
        Stop
      </button>
      <button
        v-else
        @click="$emit('start', container.id)"
        class="py-1 px-3 border-none rounded text-xs font-medium cursor-pointer transition bg-success text-white hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
      >
        Start
      </button>
      <button
        @click="$emit('restart', container.id)"
        class="py-1 px-3 border-none rounded text-xs font-medium cursor-pointer transition bg-primary text-primary-text hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
      >
        Restart
      </button>
      <button
        v-if="container.state !== 'running'"
        @click="$emit('remove', container.id)"
        class="py-1 px-3 border-none rounded text-xs font-medium cursor-pointer transition bg-muted text-white hover:bg-error disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Remove container"
      >
        Remove
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Container } from '@/stores/docker';

interface Props {
  container: Container;
  actionInProgress?: boolean;
  view?: 'grid' | 'list';
}

const props = withDefaults(defineProps<Props>(), {
  view: 'grid',
});

defineEmits<{
  start: [id: string];
  stop: [id: string];
  restart: [id: string];
  remove: [id: string];
}>();

const statusClasses = computed(() => ({
  'bg-green-100 text-green-800': props.container.state === 'running',
  'bg-red-100 text-red-800': props.container.state === 'exited' || props.container.state === 'stopped',
}));

const editUrl = computed(() => {
  if (props.container.managed !== 'dockerman') return null;
  return `/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${props.container.name}.xml`;
});
</script>
