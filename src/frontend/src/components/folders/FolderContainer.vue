<template>
  <div class="mb-2">
    <FolderHeader :folder="folder" :hide-stopped="hideStopped" :hidden-count="hiddenCount" @toggle-collapse="toggleCollapse" @toggle-hide-stopped="hideStopped = !hideStopped" @edit="$emit('edit', folder)" @delete="$emit('delete', folder.id)" @update-folder="$emit('update-folder', folder)" />

    <div class="folder-content-grid" :class="{ 'folder-content-expanded': !folder.collapsed || isSearching }">
      <div class="folder-content-inner px-2 sm:px-4">
        <div class="container-list mb-4 min-h-[60px]" :class="view === 'list' ? 'flex flex-col gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4'" :data-folder-id="folder.id">
          <ContainerCard
            v-for="assoc in folderContainers"
            :key="assoc.container_name"
            :container="getContainer(assoc.container_name)!"
            :action-in-progress="actionsInProgress.get(getContainer(assoc.container_name)?.id ?? '') ?? null"
            :view="view"
            @start="handleStart"
            @stop="handleStop"
            @restart="handleRestart"
            @remove="handleRemove"
            @pull="(data) => emit('pull', data)"
          />
        </div>
        <div v-if="folderContainers.length === 0" class="text-center py-8 text-text-secondary border-2 border-dashed border-border rounded-lg mb-4 -mt-4">
          <p>No containers in this folder</p>
          <p class="text-sm italic">Drag containers here to organize them</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useStatsStore } from '@/stores/stats';
import { useSettingsStore } from '@/stores/settings';
import type { Folder } from '@/types/folder';
import FolderHeader from './FolderHeader.vue';
import ContainerCard from '@/components/docker/ContainerCard.vue';

interface Props {
  folder: Folder;
  view?: 'grid' | 'list';
}

const props = withDefaults(defineProps<Props>(), {
  view: 'grid',
});

// Note: emit is used in template via $emit
const emit = defineEmits<{
  edit: [folder: Folder];
  delete: [id: number];
  pull: [data: { image: string; name: string; managed: string | null }];
  'update-folder': [folder: Folder];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const statsStore = useStatsStore();
const settingsStore = useSettingsStore();
const actionsInProgress = ref<Map<string, string>>(new Map());

const storageKey = computed(() => `docker-folders-hide-stopped-${props.folder.id}`);
const hideStopped = ref(localStorage.getItem(`docker-folders-hide-stopped-${props.folder.id}`) === '1');
watch(hideStopped, (v) => localStorage.setItem(storageKey.value, v ? '1' : '0'));

const isSearching = computed(() => dockerStore.searchQuery.trim().length > 0);

const folderContainers = computed(() => {
  let list = props.folder.containers || [];
  if (isSearching.value) {
    const q = dockerStore.searchQuery.trim().toLowerCase();
    list = list.filter((assoc) => {
      const container = getContainer(assoc.container_name);
      if (container) {
        return container.name.toLowerCase().includes(q) || container.image.toLowerCase().includes(q);
      }
      return assoc.container_name.toLowerCase().includes(q);
    });
  }
  if (hideStopped.value) {
    list = list.filter((assoc) => {
      const container = getContainer(assoc.container_name);
      return container?.state === 'running';
    });
  }
  return list;
});

const hiddenCount = computed(() => {
  if (!hideStopped.value) return 0;
  const all = props.folder.containers || [];
  return all.length - all.filter((assoc) => {
    const container = getContainer(assoc.container_name);
    return container?.state === 'running';
  }).length;
});

function getContainer(name: string) {
  return dockerStore.containers.find((c) => c.name === name);
}

function toggleCollapse() {
  const wasCollapsed = props.folder.collapsed;
  folderStore.toggleFolderCollapse(props.folder.id);

  // Pre-fetch stats for running containers when expanding a folder
  // so data is ready by the time ContainerCard components mount
  if (wasCollapsed && settingsStore.showStats) {
    for (const assoc of folderContainers.value) {
      const container = getContainer(assoc.container_name);
      if (container?.state === 'running') {
        statsStore.registerVisible(container.id);
      }
    }
  }
}

// When collapsed, register running containers for stats polling so folder header can show averages.
// When expanded, ContainerCard handles its own registration, so we unregister ours.
const collapsedRegisteredIds = ref(new Set<string>());

function registerCollapsedStats() {
  unregisterCollapsedStats();
  if (!props.folder.collapsed || !settingsStore.showStats) return;
  for (const assoc of folderContainers.value) {
    const container = getContainer(assoc.container_name);
    if (container?.state === 'running') {
      statsStore.registerVisible(container.id);
      collapsedRegisteredIds.value.add(container.id);
    }
  }
}

function unregisterCollapsedStats() {
  for (const id of collapsedRegisteredIds.value) {
    statsStore.unregisterVisible(id);
  }
  collapsedRegisteredIds.value.clear();
}

onMounted(() => registerCollapsedStats());
onUnmounted(() => unregisterCollapsedStats());

watch(() => props.folder.collapsed, () => {
  if (props.folder.collapsed) {
    // Wait for ContainerCards to unmount first, then register
    nextTick(() => registerCollapsedStats());
  } else {
    unregisterCollapsedStats();
  }
});

watch(() => settingsStore.showStats, () => registerCollapsedStats());

async function handleStart(id: string) {
  actionsInProgress.value.set(id, 'start');
  try {
    await dockerStore.startContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleStop(id: string) {
  actionsInProgress.value.set(id, 'stop');
  try {
    await dockerStore.stopContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleRestart(id: string) {
  actionsInProgress.value.set(id, 'restart');
  try {
    await dockerStore.restartContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

async function handleRemove(id: string) {
  actionsInProgress.value.set(id, 'remove');
  try {
    await dockerStore.removeContainer(id);
  } finally {
    actionsInProgress.value.delete(id);
  }
}
</script>
