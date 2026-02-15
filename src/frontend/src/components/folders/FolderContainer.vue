<template>
  <div class="folder-container">
    <FolderHeader :folder="folder" @toggle-collapse="toggleCollapse" @edit="$emit('edit', folder)" @delete="$emit('delete', folder.id)" />

    <div v-if="!folder.collapsed" class="folder-content">
      <div v-if="folderContainers.length === 0" class="empty-folder">
        <p>No containers in this folder</p>
        <p class="hint">Drag containers here to organize them</p>
      </div>

      <div v-else class="container-list" :data-folder-id="folder.id">
        <ContainerCard
          v-for="assoc in folderContainers"
          :key="assoc.container_id"
          :container="getContainer(assoc.container_id)!"
          :action-in-progress="actionInProgress === assoc.container_id"
          @start="handleStart"
          @stop="handleStop"
          @restart="handleRestart"
          @remove="handleRemove"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import type { Folder } from '@/types/folder';
import FolderHeader from './FolderHeader.vue';
import ContainerCard from '@/components/docker/ContainerCard.vue';

interface Props {
  folder: Folder;
}

const props = defineProps<Props>();

// Note: emit is used in template via $emit
defineEmits<{
  edit: [folder: Folder];
  delete: [id: number];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const actionInProgress = ref<string | null>(null);

const folderContainers = computed(() => {
  return props.folder.containers || [];
});

function getContainer(id: string) {
  return dockerStore.containers.find((c) => c.id === id);
}

function toggleCollapse() {
  folderStore.toggleFolderCollapse(props.folder.id);
}

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
  const container = dockerStore.containers.find((c) => c.id === id);
  const name = container?.name || id.substring(0, 12);
  if (!confirm(`Are you sure you want to remove container "${name}"? This cannot be undone.`)) {
    return;
  }
  actionInProgress.value = id;
  try {
    await dockerStore.removeContainer(id);
  } finally {
    actionInProgress.value = null;
  }
}
</script>

<style scoped>
.folder-container {
  margin-bottom: var(--spacing-xl);
}

.folder-content {
  padding: 0 var(--spacing-md);
}

.empty-folder {
  text-align: center;
  padding: var(--spacing-xl);
  color: var(--color-text-secondary);
  background-color: #fafafa;
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-md);
}

.empty-folder p {
  margin: var(--spacing-xs) 0;
}

.hint {
  font-size: var(--font-size-sm);
  font-style: italic;
}

.container-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-md);
}
</style>
