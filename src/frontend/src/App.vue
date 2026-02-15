<template>
  <div id="unraid-docker-folders-modern">
    <header class="header">
      <div class="header-left">
        <h1>Docker Containers</h1>
        <span class="stats">{{ dockerStore.containerCount}} containers, {{ folderStore.folderCount }} folders</span>
        <ConnectionStatus />
      </div>
      <div class="header-right">
        <button @click="openCreateFolderModal" class="btn btn-primary">+ Create Folder</button>
      </div>
    </header>

    <main class="main-content">
      <div v-if="isLoading" class="loading">
        <p>Loading...</p>
      </div>

      <div v-else-if="error" class="error">
        <p>Error: {{ error }}</p>
        <button @click="loadData">Retry</button>
      </div>

      <div v-else>
        <!-- Folders -->
        <div v-if="folderStore.sortedFolders.length > 0" class="folders-section">
          <FolderContainer
            v-for="folder in folderStore.sortedFolders"
            :key="folder.id"
            :folder="folder"
            @edit="openEditFolderModal"
            @delete="deleteFolder"
          />
        </div>

        <!-- Unfoldered Containers -->
        <div v-if="dockerStore.unfolderedContainers.length > 0" class="unfoldered-section">
          <div class="section-header">
            <h2>Unfoldered Containers</h2>
            <span class="container-count">{{ dockerStore.unfolderedContainers.length }}</span>
          </div>

          <div class="container-list" id="unfoldered-containers">
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
        <div v-if="dockerStore.containerCount === 0" class="empty-state">
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
    // Update existing folder
    await folderStore.updateFolder(editingFolder.value.id, data as FolderUpdateData);
  } else {
    // Create new folder
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

<style>
/* Global styles */
#unraid-docker-folders-modern {
  font-family: var(--font-family);
  max-width: 1400px;
  margin: 0 auto;
  padding: var(--spacing-lg);
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-xl);
  padding-bottom: var(--spacing-lg);
  border-bottom: 2px solid var(--color-border);
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-md);
}

.header-left h1 {
  margin: 0;
  font-size: var(--font-size-xxl);
  color: var(--color-text);
}

.stats {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.header-right {
  display: flex;
  gap: var(--spacing-sm);
}

.btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-md);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-primary {
  background-color: var(--color-primary);
  color: white;
}

.btn-primary:hover {
  background-color: #1976d2;
}

.main-content {
  min-height: 400px;
}

.loading,
.error,
.empty-state {
  text-align: center;
  padding: var(--spacing-xl) var(--spacing-lg);
  color: var(--color-text-secondary);
}

.error {
  color: var(--color-error);
}

.error button {
  margin-top: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-lg);
  background-color: var(--color-error);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.folders-section {
  margin-bottom: var(--spacing-xl);
}

.unfoldered-section {
  margin-top: var(--spacing-xl);
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}

.section-header h2 {
  margin: 0;
  font-size: var(--font-size-xl);
  color: var(--color-text);
}

.container-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 var(--spacing-sm);
  background-color: var(--color-text-secondary);
  color: white;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.container-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: var(--spacing-md);
}

/* Drag and drop styles */
.sortable-ghost {
  opacity: 0.4;
}

.sortable-drag {
  cursor: grabbing !important;
}
</style>
