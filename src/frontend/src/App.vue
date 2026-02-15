<template>
  <div id="unraid-docker-folders-modern" class="max-w-[1400px] mx-auto p-6 font-sans text-text bg-bg">
    <header class="flex justify-between items-center mb-8 pb-6 border-b-2 border-border">
      <div class="flex items-baseline gap-4">
        <span class="text-sm text-text-secondary">{{ dockerStore.containerCount }} containers, {{ folderStore.folderCount }} folders</span>
        <ConnectionStatus />
      </div>
      <div class="flex gap-2">
        <button @click="openCreateFolderModal" class="px-6 py-2 border-none rounded text-base font-medium cursor-pointer bg-button text-button-text hover:bg-button-hover transition-colors">+ Create Folder</button>
      </div>
    </header>

    <main class="min-h-[400px]">
      <div v-if="isLoading" class="text-center py-8 px-6 text-text-secondary">
        <p>Loading...</p>
      </div>

      <div v-else-if="error" class="text-center py-8 px-6 text-error">
        <p>Error: {{ error }}</p>
        <button @click="loadData" class="mt-4 px-6 py-2 bg-error text-white border-none rounded cursor-pointer">Retry</button>
      </div>

      <div v-else>
        <!-- Folders -->
        <div v-if="folderStore.sortedFolders.length > 0" class="mb-8">
          <FolderContainer v-for="folder in folderStore.sortedFolders" :key="folder.id" :folder="folder" @edit="openEditFolderModal" @delete="deleteFolder" />
        </div>

        <!-- Unfoldered Containers -->
        <div v-if="dockerStore.unfolderedContainers.length > 0" class="mt-8">
          <div class="flex items-center gap-2 mb-6">
            <h2 class="text-2xl font-semibold text-text">Unfoldered Containers</h2>
            <span class="inline-flex items-center justify-center min-w-6 h-6 px-2 bg-text-secondary text-white rounded-full text-xs font-semibold">{{ dockerStore.unfolderedContainers.length }}</span>
          </div>

          <div class="grid grid-cols-[repeat(auto-fill,minmax(350px,1fr))] gap-4" id="unfoldered-containers">
            <ContainerCard
              v-for="container in dockerStore.unfolderedContainers"
              :key="container.id"
              :container="container"
              :action-in-progress="actionInProgress === container.id"
              @start="handleStart"
              @stop="handleStop"
              @restart="handleRestart"
              @remove="handleRemove"
            />
          </div>
        </div>

        <!-- Empty State -->
        <div v-if="dockerStore.containerCount === 0" class="text-center py-8 px-6 text-text-secondary">
          <p>No Docker containers found</p>
        </div>
      </div>
    </main>

    <!-- Folder Edit Modal -->
    <FolderEditModal :is-open="isModalOpen" :folder="editingFolder" @close="closeModal" @save="saveFolder" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { initWebSocket } from '@/composables/useWebSocket';
import FolderContainer from '@/components/folders/FolderContainer.vue';
import FolderEditModal from '@/components/folders/FolderEditModal.vue';
import ContainerCard from '@/components/docker/ContainerCard.vue';
import ConnectionStatus from '@/components/ConnectionStatus.vue';
import type { Folder, FolderCreateData, FolderUpdateData } from '@/types/folder';
import Sortable from 'sortablejs';

const dockerStore = useDockerStore();
const folderStore = useFolderStore();

const actionInProgress = ref<string | null>(null);
const isModalOpen = ref(false);
const editingFolder = ref<Folder | null>(null);

const isLoading = computed(() => dockerStore.loading || folderStore.loading);
const error = computed(() => dockerStore.error || folderStore.error);

onMounted(async () => {
  await loadData();
  initializeDragAndDrop();
  initWebSocket();
});

async function loadData() {
  try {
    await Promise.all([dockerStore.fetchContainers(), folderStore.fetchFolders()]);
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

function initializeDragAndDrop() {
  // Wait for next tick to ensure DOM is ready
  setTimeout(() => {
    // Make each folder's container list sortable
    document.querySelectorAll('.container-list[data-folder-id]').forEach((el) => {
      const folderId = parseInt((el as HTMLElement).dataset.folderId || '0');

      new Sortable(el as HTMLElement, {
        group: 'containers',
        animation: 150,
        onAdd: async (evt) => {
          const containerId = evt.item.dataset.containerId;
          const containerName = dockerStore.getContainerById(containerId!)?.name || '';

          if (containerId) {
            await folderStore.addContainerToFolder(folderId, containerId, containerName);
            await folderStore.fetchFolders(); // Refresh to get updated positions
          }
        },
        onUpdate: async () => {
          // Get new order of container IDs
          const containerIds = Array.from(el.children).map((child) => (child as HTMLElement).dataset.containerId || '');

          await folderStore.reorderContainers(folderId, containerIds);
        },
      });
    });

    // Make unfoldered container list sortable
    const unfolderedEl = document.getElementById('unfoldered-containers');
    if (unfolderedEl) {
      new Sortable(unfolderedEl, {
        group: 'containers',
        animation: 150,
        onAdd: async (evt) => {
          // Container was dropped into unfoldered area - remove from folder
          const containerId = evt.item.dataset.containerId;

          if (containerId) {
            await folderStore.removeContainerFromFolder(containerId);
            await folderStore.fetchFolders();
          }
        },
      });
    }
  }, 100);
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
  const container = dockerStore.getContainerById(id);
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

function openCreateFolderModal() {
  editingFolder.value = null;
  isModalOpen.value = true;
}

function openEditFolderModal(folder: Folder) {
  editingFolder.value = folder;
  isModalOpen.value = true;
}

function closeModal() {
  isModalOpen.value = false;
  editingFolder.value = null;
}

async function saveFolder(data: FolderCreateData | FolderUpdateData) {
  if (editingFolder.value) {
    await folderStore.updateFolder(editingFolder.value.id, data as FolderUpdateData);
  } else {
    await folderStore.createFolder(data as FolderCreateData);
  }

  closeModal();

  // Re-initialize drag and drop for new folder
  setTimeout(initializeDragAndDrop, 100);
}

async function deleteFolder(id: number) {
  if (confirm('Are you sure you want to delete this folder? Containers will be moved to unfoldered.')) {
    await folderStore.deleteFolder(id);
  }
}
</script>
