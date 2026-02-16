<template>
  <div class="mb-2">
    <FolderHeader :folder="folder" @toggle-collapse="toggleCollapse" @edit="$emit('edit', folder)" @delete="$emit('delete', folder.id)" />

    <div v-if="!folder.collapsed" class="px-2 sm:px-4">
      <div class="container-list mb-4 min-h-[60px]" :class="view === 'list' ? 'flex flex-col gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4'" :data-folder-id="folder.id">
        <ContainerCard
          v-for="assoc in folderContainers"
          :key="assoc.container_name"
          :container="getContainer(assoc.container_name)!"
          :action-in-progress="actionInProgress === assoc.container_name"
          :view="view"
          @start="handleStart"
          @stop="handleStop"
          @restart="handleRestart"
          @remove="handleRemove"
        />
      </div>
      <div v-if="folderContainers.length === 0" class="text-center py-8 text-text-secondary border-2 border-dashed border-border rounded-lg mb-4 -mt-4">
        <p>No containers in this folder</p>
        <p class="text-sm italic">Drag containers here to organize them</p>
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
defineEmits<{
  edit: [folder: Folder];
  delete: [id: number];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const statsStore = useStatsStore();
const settingsStore = useSettingsStore();
const actionInProgress = ref<string | null>(null);

const folderContainers = computed(() => {
  return props.folder.containers || [];
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
  actionInProgress.value = id;
  try {
    await dockerStore.startContainer(id);
  } finally {
    actionInProgress.value = null;
  }
}

async function handleStop(id: string) {
  actionInProgress.value = id;
  try {
    await dockerStore.stopContainer(id);
  } finally {
    actionInProgress.value = null;
  }
}

async function handleRestart(id: string) {
  actionInProgress.value = id;
  try {
    await dockerStore.restartContainer(id);
  } finally {
    actionInProgress.value = null;
  }
}

async function handleRemove(id: string) {
  actionInProgress.value = id;
  try {
    await dockerStore.removeContainer(id);
  } finally {
    actionInProgress.value = null;
  }
}
</script>
