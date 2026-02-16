<template>
  <div id="unraid-docker-folders-modern" class="unapi px-3 py-2 sm:px-6 sm:py-4 font-sans text-text">
    <header class="flex flex-wrap justify-between items-center gap-y-3 gap-x-4 mb-4 pb-4 sm:mb-8 sm:pb-6 border-b-2 border-border">
      <div class="flex items-center gap-2 sm:gap-4">
        <a href="/Settings/DockerFoldersSettings" class="nav-btn" title="Settings" style="text-decoration: none;">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </a>
        <span class="text-sm text-text-secondary">{{ dockerStore.containerCount }} containers, {{ folderStore.folderCount }} folders</span>
        <ConnectionStatus />
      </div>
      <div class="flex gap-2 sm:gap-3 items-center">
        <div class="relative">
          <input
            v-model="dockerStore.searchQuery"
            type="text"
            placeholder="Search containers..."
            class="nav-btn text-sm pl-3 pr-7 py-1 w-40 sm:w-52 border border-border rounded bg-transparent text-text placeholder:text-text-secondary focus:outline-none focus:border-text-secondary"
          />
          <button
            v-if="dockerStore.searchQuery"
            @click="dockerStore.searchQuery = ''"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text cursor-pointer bg-transparent border-none p-0 leading-none text-base"
            title="Clear search"
          >&times;</button>
        </div>
        <div class="flex">
          <button
            @click="viewMode = 'grid'"
            class="nav-btn"
            :class="{ active: viewMode === 'grid' }"
            title="Grid view"
          >
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
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
          <button
            @click="viewMode = 'list'"
            class="nav-btn"
            :class="{ active: viewMode === 'list' }"
            title="List view"
          >
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
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
        <button
          @click="dragLocked = !dragLocked"
          class="nav-btn"
          :class="{ warning: dragLocked }"
          :title="dragLocked ? 'Unlock drag & drop' : 'Lock drag & drop'"
        >
          <svg v-if="dragLocked" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></svg>
        </button>
        <button
          @click="openCreateFolderModal"
          class="nav-btn active"
        >
          + Create Folder
        </button>
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
        <div v-if="filteredFolders.length > 0" id="folder-list" class="mb-8">
          <FolderContainer
            v-for="folder in filteredFolders"
            :key="folder.id"
            :folder="folder"
            :view="viewMode"
            :data-folder-sort-id="folder.id"

            @edit="openEditFolderModal"
            @delete="deleteFolder"
          />
        </div>

        <!-- Unfoldered Containers -->
        <div v-if="filteredUnfolderedContainers.length > 0" class="mt-8">
          <div
            class="flex items-center gap-2 mb-4 cursor-pointer select-none"
            @click="unfolderedCollapsed = !unfolderedCollapsed"
          >
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
              class="shrink-0 text-text-secondary transition-transform duration-200"
              :class="unfolderedCollapsed ? '-rotate-90' : ''"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <h2 class="text-sm font-semibold text-text">Unfoldered Containers</h2>
            <span class="inline-flex items-center justify-center min-w-6 h-6 px-2 bg-text-secondary text-white rounded-full text-xs font-semibold">{{
              filteredUnfolderedContainers.length
            }}</span>
          </div>

          <div
            v-if="!unfolderedCollapsed"
            class="container-list"
            :class="viewMode === 'list' ? 'flex flex-col gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4'"
            id="unfoldered-containers"
          >
            <ContainerCard
              v-for="container in filteredUnfolderedContainers"
              :key="container.id"
              :container="container"
              :action-in-progress="actionInProgress === container.id"
              :view="viewMode"

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

    <Teleport to="body">
      <ConfirmModal
        :is-open="!!deletingFolderId"
        title="Delete Folder"
        :message="`Delete &quot;${deletingFolderName}&quot;? Containers will be moved to unfoldered.`"
        confirm-label="Delete"
        variant="danger"
        @confirm="confirmDeleteFolder"
        @cancel="deletingFolderId = null"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick, provide, toRef } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { initWebSocket } from '@/composables/useWebSocket';
import FolderContainer from '@/components/folders/FolderContainer.vue';
import FolderEditModal from '@/components/folders/FolderEditModal.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import ContainerCard from '@/components/docker/ContainerCard.vue';
import ConnectionStatus from '@/components/ConnectionStatus.vue';
import type { Folder, FolderCreateData, FolderUpdateData } from '@/types/folder';
import Sortable from 'sortablejs';

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const settingsStore = useSettingsStore();
const statsStore = useStatsStore();

const actionInProgress = ref<string | null>(null);
const viewMode = ref<'grid' | 'list'>((localStorage.getItem('docker-folders-view') as 'grid' | 'list') || 'grid');
watch(viewMode, (v) => localStorage.setItem('docker-folders-view', v));

const unfolderedCollapsed = ref(localStorage.getItem('docker-folders-unfoldered-collapsed') === '1');
watch(unfolderedCollapsed, (v) => localStorage.setItem('docker-folders-unfoldered-collapsed', v ? '1' : '0'));

const dragLocked = ref(localStorage.getItem('docker-folders-drag-locked') === '1');
watch(dragLocked, (v) => {
  localStorage.setItem('docker-folders-drag-locked', v ? '1' : '0');
  nextTick(() => initializeDragAndDrop());
});

provide('distinguishHealthy', toRef(settingsStore, 'distinguishHealthy'));
provide('dragLocked', dragLocked);
const isModalOpen = ref(false);
const editingFolder = ref<Folder | null>(null);

const isLoading = computed(() => dockerStore.loading || folderStore.loading);
const error = computed(() => dockerStore.error || folderStore.error);

const isSearching = computed(() => dockerStore.searchQuery.trim().length > 0);

function containerMatchesSearch(name: string, image?: string): boolean {
  const q = dockerStore.searchQuery.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q) || (image ? image.toLowerCase().includes(q) : false);
}

const filteredUnfolderedContainers = computed(() => {
  if (!isSearching.value) return dockerStore.unfolderedContainers;
  return dockerStore.unfolderedContainers.filter((c) => containerMatchesSearch(c.name, c.image));
});

const filteredFolders = computed(() => {
  if (!isSearching.value) return folderStore.sortedFolders;
  const q = dockerStore.searchQuery.trim().toLowerCase();
  return folderStore.sortedFolders.filter((folder) =>
    (folder.containers || []).some((assoc) => {
      const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
      return container ? containerMatchesSearch(container.name, container.image) : assoc.container_name.toLowerCase().includes(q);
    })
  );
});

// Track Sortable instances so we can destroy them before re-creating
let sortableInstances: Sortable[] = [];

onMounted(async () => {
  await loadData();
  initializeDragAndDrop();
  initWebSocket();
});

// Re-initialize drag-and-drop whenever folders, containers, or search change.
watch(
  () => [folderStore.folders, dockerStore.containers, dockerStore.searchQuery],
  () => {
    nextTick(() => initializeDragAndDrop());
  },
  { deep: true }
);

async function loadData() {
  try {
    await Promise.all([dockerStore.fetchContainers(), folderStore.fetchFolders(), settingsStore.fetchSettings()]);
    // Pre-fetch stats for all running containers so data is ready before components mount
    if (settingsStore.showStats) {
      const runningIds = dockerStore.containers
        .filter((c) => c.state === 'running')
        .map((c) => c.id);
      for (const id of runningIds) {
        statsStore.registerVisible(id);
      }
    }
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

function destroyDragAndDrop() {
  for (const instance of sortableInstances) {
    instance.destroy();
  }
  sortableInstances = [];
}

function initializeDragAndDrop() {
  destroyDragAndDrop();

  if (dragLocked.value || isSearching.value) return;

  // Make folder list sortable (reorder folders)
  const folderListEl = document.getElementById('folder-list');
  if (folderListEl) {
    sortableInstances.push(
      new Sortable(folderListEl, {
        handle: '.folder-drag-handle',
        animation: 150,
        onEnd: async () => {
          const folderIds = Array.from(folderListEl.children)
            .map((child) => parseInt((child as HTMLElement).dataset.folderSortId || '0'))
            .filter((id) => id > 0);
          if (folderIds.length > 0) {
            await folderStore.reorderFolders(folderIds);
          }
        },
      })
    );
  }

  // Make each folder's container list sortable
  document.querySelectorAll('.container-list[data-folder-id]').forEach((el) => {
    const folderId = parseInt((el as HTMLElement).dataset.folderId || '0');

    sortableInstances.push(
      new Sortable(el as HTMLElement, {
        group: 'containers',
        handle: '.drag-handle',
        animation: 150,
        onAdd: async (evt) => {
          const containerId = evt.item.dataset.containerId;
          const containerName = dockerStore.getContainerById(containerId!)?.name || '';

          if (containerId) {
            await folderStore.addContainerToFolder(folderId, containerId, containerName);
            await folderStore.fetchFolders(true);
          }
        },
        onUpdate: async () => {
          const containerIds = Array.from(el.children).map((child) => (child as HTMLElement).dataset.containerId || '');
          await folderStore.reorderContainers(folderId, containerIds);
        },
      })
    );
  });

  // Make unfoldered container list sortable
  const unfolderedEl = document.getElementById('unfoldered-containers');
  if (unfolderedEl) {
    sortableInstances.push(
      new Sortable(unfolderedEl, {
        group: 'containers',
        handle: '.drag-handle',
        animation: 150,
        onAdd: async (evt) => {
          const containerId = evt.item.dataset.containerId;
          const containerName = dockerStore.getContainerById(containerId!)?.name || '';

          if (containerName) {
            await folderStore.removeContainerFromFolder(containerName);
            await folderStore.fetchFolders(true);
          }
        },
      })
    );
  }
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

async function saveFolder(data: FolderCreateData | FolderUpdateData, containerIds: string[] = []) {
  let folderId: number | null = null;

  if (editingFolder.value) {
    await folderStore.updateFolder(editingFolder.value.id, data as FolderUpdateData);
    folderId = editingFolder.value.id;
  } else {
    const folder = await folderStore.createFolder(data as FolderCreateData);
    folderId = folder?.id ?? null;
  }

  if (folderId != null && containerIds.length > 0) {
    for (const cid of containerIds) {
      const name = dockerStore.getContainerById(cid)?.name || '';
      await folderStore.addContainerToFolder(folderId, cid, name);
    }
    await folderStore.fetchFolders(true);
  }

  closeModal();
}

const deletingFolderId = ref<number | null>(null);
const deletingFolderName = computed(() => {
  if (!deletingFolderId.value) return '';
  return folderStore.folders.find((f) => f.id === deletingFolderId.value)?.name || 'this folder';
});

function deleteFolder(id: number) {
  deletingFolderId.value = id;
}

async function confirmDeleteFolder() {
  if (deletingFolderId.value) {
    await folderStore.deleteFolder(deletingFolderId.value);
  }
  deletingFolderId.value = null;
}
</script>
