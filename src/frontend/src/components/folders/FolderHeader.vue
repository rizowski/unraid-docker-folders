<template>
  <div
    class="flex justify-between items-center px-6 py-4 bg-bg rounded-sm mb-4 cursor-pointer select-none border-l-4 hover:brightness-95 transition"
    :style="{ borderLeftColor: folder.color || '#ff8c2f' }"
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
      <button
        class="bg-transparent border-none p-1 cursor-pointer text-sm text-text-secondary flex items-center justify-center w-6 h-6"
        @click="$emit('toggle-collapse')"
        :aria-label="folder.collapsed ? 'Expand folder' : 'Collapse folder'"
      >
        <span class="transition-transform">{{ folder.collapsed ? '▶' : '▼' }}</span>
      </button>
      <div
        v-if="containerIcons.length > 0"
        class="grid shrink-0 gap-0.5 mr-2"
        :class="containerIcons.length > 1 ? 'grid-cols-2 w-12 h-12' : 'grid-cols-1 w-12 h-12'"
      >
        <img v-for="(icon, i) in containerIcons" :key="i" :src="icon" class="w-full h-full object-contain rounded-sm" />
      </div>
      <h2 class="text-lg font-semibold text-text mr-1">{{ folder.name }}</h2>
      <span
        v-if="folder.compose_project"
        class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 text-blue-400 rounded text-[11px] font-medium tracking-wide uppercase mr-1"
        :title="`Auto-grouped from compose project: ${folder.compose_project}`"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>
        Compose
      </span>
      <span class="inline-flex items-center justify-center min-w-6 h-6 px-2 bg-primary text-primary-text rounded-full text-xs font-semibold ml-1">{{
        folder.containers.length
      }}</span>
    </div>
    <div class="flex gap-1">
      <button
        class="bg-transparent border-none px-2 py-1 cursor-pointer text-base opacity-60 hover:opacity-100 hover:scale-110 transition"
        @click="$emit('edit')"
        title="Edit folder"
      >
        ✏️
      </button>
      <button
        class="bg-transparent border-none px-2 py-1 cursor-pointer text-base opacity-60 hover:opacity-100 hover:scale-110 transition"
        @click="$emit('delete')"
        title="Delete folder"
      >
        🗑️
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDockerStore } from '@/stores/docker';
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
