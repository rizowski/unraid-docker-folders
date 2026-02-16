<template>
  <div
    class="flex justify-between items-center px-6 py-4 bg-bg rounded-sm mb-4 cursor-pointer select-none border-l-4 hover:brightness-95 transition"
    :style="{ borderLeftColor: folder.color || '#ff8c2f' }"
    @click="$emit('toggle-collapse')"
  >
    <div class="flex items-center gap-2 flex-1">
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
        class="folder-drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing"
      >
        <circle cx="9" cy="5" r="1" />
        <circle cx="9" cy="12" r="1" />
        <circle cx="9" cy="19" r="1" />
        <circle cx="15" cy="5" r="1" />
        <circle cx="15" cy="12" r="1" />
        <circle cx="15" cy="19" r="1" />
      </svg>
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
        :class="folder.collapsed ? '-rotate-90' : ''"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <div
        v-if="containerIcons.length > 0"
        class="grid shrink-0 gap-0.5 mr-2"
        :class="containerIcons.length > 1 ? 'grid-cols-2 w-9 h-9' : 'grid-cols-1 w-9 h-9'"
      >
        <img v-for="(icon, i) in containerIcons" :key="i" :src="icon" class="w-full h-full object-contain rounded-sm" />
      </div>
      <h2 class="text-sm font-semibold text-text mr-1">{{ folder.name }}</h2>
      <span
        v-if="folder.compose_project"
        class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 text-blue-400 rounded text-[11px] font-medium tracking-wide uppercase mr-1"
        :title="`Auto-grouped from compose project: ${folder.compose_project}`"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>
        Compose
      </span>
      <span class="inline-flex items-center justify-center min-w-6 h-6 px-2 bg-primary text-primary-text rounded-full text-xs font-semibold ml-1" :title="`${runningCount} running / ${folder.containers.length} total`">
        {{ runningCount }}/{{ folder.containers.length }}
      </span>
      <span v-if="folder.collapsed && collapsedPorts" class="text-[11px] text-muted font-mono ml-2 truncate">{{ collapsedPorts }}</span>
    </div>
    <div class="flex gap-1">
      <button
        class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-text transition"
        @click.stop="$emit('edit')"
        title="Edit folder"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </button>
      <button
        class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-error transition"
        @click.stop="$emit('delete')"
        title="Delete folder"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import type { Folder } from '@/types/folder';

interface Props {
  folder: Folder;
}

const props = defineProps<Props>();

defineEmits<{
  'toggle-collapse': [];
  edit: [];
  delete: [];
}>();

const dockerStore = useDockerStore();
const settingsStore = useSettingsStore();

const collapsedPorts = computed(() => {
  if (!settingsStore.showFolderPorts) return '';
  const ports: number[] = [];
  for (const assoc of props.folder.containers) {
    const container = dockerStore.containers.find((c) => c.id === assoc.container_id);
    if (container?.state !== 'running' || !container.ports?.length) continue;
    for (const p of container.ports) {
      if (p.PublicPort && !ports.includes(p.PublicPort)) {
        ports.push(p.PublicPort);
      }
    }
  }
  if (!ports.length) return '';
  return ports.sort((a, b) => a - b).join(', ');
});

const runningCount = computed(() => {
  return props.folder.containers.filter((assoc) => {
    const container = dockerStore.containers.find((c) => c.id === assoc.container_id);
    return container?.state === 'running';
  }).length;
});

const containerIcons = computed(() => {
  const icons: string[] = [];
  for (const assoc of props.folder.containers) {
    const container = dockerStore.containers.find((c) => c.id === assoc.container_id);
    if (container?.icon) icons.push(container.icon);
    if (icons.length >= 4) break;
  }
  return icons;
});
</script>
