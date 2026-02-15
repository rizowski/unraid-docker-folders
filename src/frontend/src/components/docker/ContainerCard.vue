<template>
  <!-- Grid (card) view -->
  <div v-if="view === 'grid'" class="border border-border rounded-lg bg-bg-card shadow-sm hover:shadow-md transition" :data-container-id="container.id">
    <div class="flex items-center gap-2 p-6 pb-0">
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
      <img :src="container.icon || fallbackIcon" :alt="container.name" class="w-10 h-10 object-contain shrink-0" />
      <span class="w-3 h-3 rounded-full shrink-0" :class="statusDotClass" :title="statusTooltip"></span>
      <h3 class="flex-1 text-lg font-semibold text-text truncate">{{ container.name }}</h3>
      <a
        v-if="editUrl"
        :href="editUrl"
        class="shrink-0 text-text-secondary hover:text-text transition"
        title="Edit container"
        @click.stop
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </a>
    </div>

    <!-- Clickable summary row -->
    <div class="flex items-center gap-2 px-6 py-2 cursor-pointer select-none" @click="expanded = !expanded">
      <p class="flex-1 text-sm text-text-secondary font-mono truncate">
        <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="hover:underline" @click.stop>{{ container.image }}</a>
        <span v-else>{{ container.image }}</span>
      </p>
      <span class="text-xs text-muted">{{ container.status }}</span>
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
        class="shrink-0 text-muted transition-transform duration-200"
        :class="expanded ? 'rotate-180' : ''"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>

    <!-- Compact stats bars (always visible for running containers) -->
    <div v-if="isRunning && containerStats && !expanded" class="px-6 pb-1 space-y-1">
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted w-8 shrink-0">CPU</span>
        <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-300" :class="cpuBarColor" :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"></div>
        </div>
        <span class="text-text-secondary font-mono w-12 text-right shrink-0">{{ formatPercent(containerStats.cpuPercent) }}</span>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted w-8 shrink-0">MEM</span>
        <div class="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-300" :class="memBarColor" :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"></div>
        </div>
        <span class="text-text-secondary font-mono w-12 text-right shrink-0">{{ formatPercent(containerStats.memoryPercent) }}</span>
      </div>
    </div>

    <!-- Accordion details -->
    <div v-if="expanded" class="px-6 pb-2 space-y-1 text-sm border-t border-border pt-2">
      <div v-if="networkInfo" class="flex gap-2 text-text-secondary font-mono">
        <span class="text-muted shrink-0">Network</span>
        <span class="truncate">{{ networkInfo.name }} {{ networkInfo.ip }}</span>
      </div>
      <div v-if="displayPorts.length" class="space-y-0.5">
        <p class="text-muted text-xs">Ports</p>
        <p v-for="port in displayPorts" :key="port" class="text-text-secondary font-mono truncate pl-2">{{ port }}</p>
      </div>
      <div v-if="displayMounts.length" class="space-y-0.5">
        <p class="text-muted text-xs">Volumes</p>
        <p v-for="mount in displayMounts" :key="mount" class="text-text-secondary font-mono truncate pl-2" :title="mount">{{ mount }}</p>
      </div>
      <div v-if="!networkInfo && !displayPorts.length && !displayMounts.length" class="text-muted text-xs italic">
        No additional details available
      </div>

      <!-- Resource Usage Stats -->
      <div v-if="isRunning && containerStats" class="space-y-1.5 pt-1 border-t border-border mt-1">
        <p class="text-muted text-xs">Resource Usage</p>
        <!-- CPU Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">CPU</span>
            <span class="text-text-secondary font-mono">{{ formatPercent(containerStats.cpuPercent) }}</span>
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" :class="cpuBarColor" :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"></div>
          </div>
        </div>
        <!-- Memory Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">Memory</span>
            <span class="text-text-secondary font-mono">{{ formatBytes(containerStats.memoryUsage) }} / {{ formatBytes(containerStats.memoryLimit) }} ({{ formatPercent(containerStats.memoryPercent) }})</span>
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" :class="memBarColor" :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"></div>
          </div>
        </div>
        <!-- Numeric Stats -->
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs pt-0.5">
          <span class="text-muted">Block I/O</span>
          <span class="text-text-secondary font-mono">Read: {{ formatBytes(containerStats.blockRead) }} / Write: {{ formatBytes(containerStats.blockWrite) }}</span>
          <span class="text-muted">Network</span>
          <span class="text-text-secondary font-mono">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
          <span class="text-muted">PIDs</span>
          <span class="text-text-secondary font-mono">{{ containerStats.pids }}</span>
          <span class="text-muted">Restarts</span>
          <span class="font-mono" :class="restartClass">{{ containerStats.restartCount }}</span>
          <span class="text-muted">Uptime</span>
          <span class="text-text-secondary font-mono">{{ formatUptime(containerStats.startedAt) }}</span>
          <span class="text-muted">Image Size</span>
          <span class="text-text-secondary font-mono">{{ formatBytes(containerStats.imageSize) }}</span>
          <span class="text-muted">Log Size</span>
          <span class="font-mono" :class="logSizeClass">{{ formatBytes(containerStats.logSize) }}</span>
        </div>
      </div>
      <div v-else-if="isRunning && !containerStats" class="text-muted text-xs italic pt-1 border-t border-border mt-1">
        Loading stats...
      </div>
      <div v-else-if="!isRunning && expanded" class="text-muted text-xs italic pt-1 border-t border-border mt-1">
        Container not running
      </div>
    </div>

    <div class="flex gap-1.5 px-6 pb-4 pt-2">
      <button
        v-if="container.state === 'running'"
        @click="confirmStop"
        class="p-2 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Stop"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
      </button>
      <button
        v-else
        @click="emit('start', container.id)"
        class="p-2 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Start"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21" /></svg>
      </button>
      <button
        @click="confirmRestart"
        class="p-2 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Restart"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
      </button>
      <button
        v-if="container.state !== 'running'"
        @click="confirmRemove"
        class="p-2 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="actionInProgress"
        title="Remove"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
      </button>
    </div>
  </div>

  <!-- List view -->
  <div v-else class="bg-bg-card border border-border rounded hover:shadow-sm transition" :data-container-id="container.id">
    <div class="flex items-center gap-4 px-4 py-3">
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
      <img :src="container.icon || fallbackIcon" :alt="container.name" class="w-6 h-6 object-contain shrink-0" />
      <span class="w-2.5 h-2.5 rounded-full shrink-0" :class="statusDotClass" :title="statusTooltip"></span>

      <!-- Clickable name/image area toggles accordion -->
      <div class="flex items-center gap-4 flex-1 min-w-0 cursor-pointer select-none" @click="expanded = !expanded">
        <span class="font-semibold text-text min-w-[140px]">{{ container.name }}</span>
        <span class="text-sm text-text-secondary font-mono truncate hidden sm:inline">
          <a v-if="imageLink" :href="imageLink" target="_blank" rel="noopener" class="hover:underline" @click.stop>{{ container.image }}</a>
          <span v-else>{{ container.image }}</span>
        </span>
        <span class="text-xs text-muted hidden md:inline">{{ container.status }}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0 text-muted transition-transform duration-200"
          :class="expanded ? 'rotate-180' : ''"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      <!-- Inline compact stats (list view) -->
      <div v-if="isRunning && containerStats && !expanded" class="shrink-0 w-[140px] space-y-0.5 hidden lg:block">
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="text-muted w-7 text-right">CPU</span>
          <div class="flex-1 h-1 bg-border rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" :class="cpuBarColor" :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"></div>
          </div>
          <span class="text-text-secondary font-mono w-9 text-right">{{ formatPercent(containerStats.cpuPercent) }}</span>
        </div>
        <div class="flex items-center gap-1.5 text-[11px]">
          <span class="text-muted w-7 text-right">MEM</span>
          <div class="flex-1 h-1 bg-border rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" :class="memBarColor" :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"></div>
          </div>
          <span class="text-text-secondary font-mono w-9 text-right">{{ formatPercent(containerStats.memoryPercent) }}</span>
        </div>
      </div>

      <div class="flex gap-0.5 ml-auto shrink-0 items-center">
        <a
          v-if="editUrl"
          :href="editUrl"
          class="text-text-secondary hover:text-text transition p-1.5"
          title="Edit container"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </a>
        <button
          v-if="container.state === 'running'"
          @click="confirmStop"
          class="p-1.5 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Stop"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
        </button>
        <button
          v-else
          @click="emit('start', container.id)"
          class="p-1.5 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Start"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21" /></svg>
        </button>
        <button
          @click="confirmRestart"
          class="p-1.5 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Restart"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
        </button>
        <button
          v-if="container.state !== 'running'"
          @click="confirmRemove"
          class="p-1.5 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="actionInProgress"
          title="Remove"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
        </button>
      </div>
    </div>

    <!-- List accordion details -->
    <div v-if="expanded" class="px-4 pb-3 pt-1 border-t border-border ml-[72px] space-y-1 text-sm">
      <div v-if="networkInfo" class="flex gap-2 text-text-secondary font-mono">
        <span class="text-muted shrink-0">Network</span>
        <span class="truncate">{{ networkInfo.name }} {{ networkInfo.ip }}</span>
      </div>
      <div v-if="displayPorts.length" class="space-y-0.5">
        <p class="text-muted text-xs">Ports</p>
        <p v-for="port in displayPorts" :key="port" class="text-text-secondary font-mono truncate pl-2">{{ port }}</p>
      </div>
      <div v-if="displayMounts.length" class="space-y-0.5">
        <p class="text-muted text-xs">Volumes</p>
        <p v-for="mount in displayMounts" :key="mount" class="text-text-secondary font-mono truncate pl-2" :title="mount">{{ mount }}</p>
      </div>
      <div v-if="!networkInfo && !displayPorts.length && !displayMounts.length" class="text-muted text-xs italic">
        No additional details available
      </div>

      <!-- Resource Usage Stats (list view) -->
      <div v-if="isRunning && containerStats" class="space-y-1.5 pt-1 border-t border-border mt-1">
        <p class="text-muted text-xs">Resource Usage</p>
        <!-- CPU Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">CPU</span>
            <span class="text-text-secondary font-mono">{{ formatPercent(containerStats.cpuPercent) }}</span>
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" :class="cpuBarColor" :style="{ width: Math.min(containerStats.cpuPercent, 100) + '%' }"></div>
          </div>
        </div>
        <!-- Memory Bar -->
        <div class="space-y-0.5">
          <div class="flex justify-between text-xs">
            <span class="text-muted">Memory</span>
            <span class="text-text-secondary font-mono">{{ formatBytes(containerStats.memoryUsage) }} / {{ formatBytes(containerStats.memoryLimit) }} ({{ formatPercent(containerStats.memoryPercent) }})</span>
          </div>
          <div class="w-full h-1.5 bg-border rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300" :class="memBarColor" :style="{ width: Math.min(containerStats.memoryPercent, 100) + '%' }"></div>
          </div>
        </div>
        <!-- Numeric Stats -->
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs pt-0.5">
          <span class="text-muted">Block I/O</span>
          <span class="text-text-secondary font-mono">Read: {{ formatBytes(containerStats.blockRead) }} / Write: {{ formatBytes(containerStats.blockWrite) }}</span>
          <span class="text-muted">Network</span>
          <span class="text-text-secondary font-mono">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
          <span class="text-muted">PIDs</span>
          <span class="text-text-secondary font-mono">{{ containerStats.pids }}</span>
          <span class="text-muted">Restarts</span>
          <span class="font-mono" :class="restartClass">{{ containerStats.restartCount }}</span>
          <span class="text-muted">Uptime</span>
          <span class="text-text-secondary font-mono">{{ formatUptime(containerStats.startedAt) }}</span>
          <span class="text-muted">Image Size</span>
          <span class="text-text-secondary font-mono">{{ formatBytes(containerStats.imageSize) }}</span>
          <span class="text-muted">Log Size</span>
          <span class="font-mono" :class="logSizeClass">{{ formatBytes(containerStats.logSize) }}</span>
        </div>
      </div>
      <div v-else-if="isRunning && !containerStats" class="text-muted text-xs italic pt-1 border-t border-border mt-1">
        Loading stats...
      </div>
      <div v-else-if="!isRunning && expanded" class="text-muted text-xs italic pt-1 border-t border-border mt-1">
        Container not running
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, onMounted, onUnmounted, type Ref } from 'vue';
import type { Container } from '@/stores/docker';
import { useStatsStore } from '@/stores/stats';
import { formatBytes, formatPercent, formatUptime } from '@/utils/format';
// Vite copies public/ files to outDir root; BASE_URL ensures correct path in dev + prod
const fallbackIcon = `${import.meta.env.BASE_URL}docker.svg`;

interface Props {
  container: Container;
  actionInProgress?: boolean;
  view?: 'grid' | 'list';
}

const props = withDefaults(defineProps<Props>(), {
  view: 'grid',
});

const emit = defineEmits<{
  start: [id: string];
  stop: [id: string];
  restart: [id: string];
  remove: [id: string];
}>();

function confirmStop() {
  if (confirm(`Stop container "${props.container.name}"?`)) {
    emit('stop', props.container.id);
  }
}

function confirmRestart() {
  if (confirm(`Restart container "${props.container.name}"?`)) {
    emit('restart', props.container.id);
  }
}

function confirmRemove() {
  if (confirm(`Remove container "${props.container.name}"? This cannot be undone.`)) {
    emit('remove', props.container.id);
  }
}

const expanded = ref(false);
const statsStore = useStatsStore();

const containerStats = computed(() => statsStore.getStats(props.container.id));
const isRunning = computed(() => props.container.state === 'running');

const cpuBarColor = computed(() => {
  const pct = containerStats.value?.cpuPercent ?? 0;
  if (pct > 80) return 'bg-error';
  if (pct > 50) return 'bg-warning';
  return 'bg-success';
});

const memBarColor = computed(() => {
  const pct = containerStats.value?.memoryPercent ?? 0;
  if (pct > 80) return 'bg-error';
  if (pct > 50) return 'bg-warning';
  return 'bg-success';
});

const logSizeClass = computed(() => {
  const size = containerStats.value?.logSize ?? 0;
  if (size > 1_073_741_824) return 'text-error';
  if (size > 104_857_600) return 'text-warning';
  return 'text-text-secondary';
});

const restartClass = computed(() => {
  return (containerStats.value?.restartCount ?? 0) > 0 ? 'text-error' : 'text-text-secondary';
});

// Register running containers for compact bar polling
onMounted(() => {
  if (isRunning.value) {
    statsStore.registerVisible(props.container.id);
  }
});

// React to container state changes (start/stop)
watch(isRunning, (running) => {
  if (running) {
    statsStore.registerVisible(props.container.id);
  } else {
    statsStore.unregisterVisible(props.container.id);
  }
});

watch(expanded, (val) => {
  if (val) {
    statsStore.registerExpanded(props.container.id);
  } else {
    statsStore.unregisterExpanded(props.container.id);
  }
});

onUnmounted(() => {
  statsStore.unregisterVisible(props.container.id);
  if (expanded.value) {
    statsStore.unregisterExpanded(props.container.id);
  }
});

const distinguishHealthy = inject<Ref<boolean>>('distinguishHealthy', ref(true));

const isHealthy = computed(() => props.container.status?.toLowerCase().includes('(healthy)'));

const statusDotClass = computed(() => {
  const state = props.container.state;
  if (state === 'running' && distinguishHealthy.value && isHealthy.value) return 'bg-green-500';
  if (state === 'running' && distinguishHealthy.value) return 'bg-blue-500';
  if (state === 'running') return 'bg-green-500';
  if (state === 'exited' || state === 'stopped') return 'bg-red-500';
  return 'bg-gray-400';
});

const statusTooltip = computed(() => {
  const state = props.container.state;
  if (state === 'running' && distinguishHealthy.value && isHealthy.value) return 'Running (healthy)';
  if (state === 'running' && distinguishHealthy.value) return 'Running (no health check)';
  if (state === 'running') return 'Running';
  if (state === 'exited') return 'Exited';
  if (state === 'stopped') return 'Stopped';
  if (state === 'created') return 'Created';
  return state.charAt(0).toUpperCase() + state.slice(1);
});

const editUrl = computed(() => {
  if (props.container.managed !== 'dockerman') return null;
  return `/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${props.container.name}.xml`;
});

const imageLink = computed(() => {
  const image = props.container.image;
  if (!image) return null;
  const nameOnly = image.split(':')[0];
  if (nameOnly.includes('.')) {
    return `https://${nameOnly}`;
  }
  if (nameOnly.includes('/')) {
    return `https://hub.docker.com/r/${nameOnly}`;
  }
  return `https://hub.docker.com/_/${nameOnly}`;
});

const networkInfo = computed(() => {
  const nets = props.container.networkSettings;
  if (!nets) return null;
  const entries = Object.entries(nets);
  if (entries.length === 0) return null;
  const [name, data] = entries[0];
  return { name, ip: data?.IPAddress || '' };
});

const displayPorts = computed(() => {
  const ports = props.container.ports;
  if (!ports?.length) return [];
  return ports.slice(0, 3).map((p) => {
    if (p.PublicPort) {
      return `${p.PrivatePort}/${p.Type} -> ${p.IP || '0.0.0.0'}:${p.PublicPort}`;
    }
    return `${p.PrivatePort}/${p.Type}`;
  });
});

const displayMounts = computed(() => {
  const mounts = props.container.mounts;
  if (!mounts?.length) return [];
  return mounts.slice(0, 2).map((m) => {
    const src = m.Source.length > 30 ? '...' + m.Source.slice(-27) : m.Source;
    return `${m.Destination} -> ${src}`;
  });
});
</script>
