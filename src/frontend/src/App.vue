<template>
  <div id="unraid-docker-folders-modern" class="unapi px-3 py-2 sm:px-6 sm:py-4 font-sans text-text bg-bg">
    <header class="flex flex-wrap justify-between items-center gap-y-3 gap-x-4 mb-4 pb-4 sm:mb-8 sm:pb-6 border-b-2 border-border">
      <div class="flex items-center gap-2 sm:gap-4 min-w-0">
        <a href="/Settings/DockerFolders" class="nav-btn shrink-0" title="Settings">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </a>
        <button
          @click="dragLocked = !dragLocked"
          class="nav-btn shrink-0"
          :class="{ warning: dragLocked }"
          :title="dragLocked ? 'Unlock drag & drop' : 'Lock drag & drop'"
        >
          <svg v-if="dragLocked" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></svg>
        </button>
        <span class="text-xs sm:text-sm text-text-secondary truncate">{{ dockerStore.containerCount }} containers, {{ folderStore.folderCount }} folders</span>
      </div>
      <!-- Its own header child rather than part of the button cluster so
           `flex-1` can eat the whole gap between the two groups. `.form-input`
           and not utilities: DESIGN.md §11 — the unlayered input reset kills
           `w-full`/`border`/`py-*` on a bare <input>, so the old `w-52` was
           already dead and the field had no box at all. -->
      <div class="relative order-last w-full min-w-0 sm:order-none sm:flex-1">
        <input
          v-model="dockerStore.searchQuery"
          type="text"
          placeholder="Search containers..."
          class="form-input subtle"
          :class="{ 'has-clear': dockerStore.searchQuery }"
        />
        <button
          v-if="dockerStore.searchQuery"
          @click="dockerStore.searchQuery = ''"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text cursor-pointer bg-transparent border-none p-0 leading-none text-base"
          title="Clear search"
        >&times;</button>
      </div>
      <div class="flex flex-wrap gap-2 sm:gap-3 items-center">
        <div class="view-mode-toggle">
          <div class="view-mode-slider" :class="{ 'slider-right': viewMode === 'list' }"></div>
          <button
            @click="viewMode = 'grid'"
            class="relative z-10 flex items-center justify-center w-8 h-7 rounded-full transition-colors duration-200 cursor-pointer"
            :class="viewMode === 'grid' ? 'text-primary-text' : 'text-text-secondary hover:text-text'"
            title="Grid view"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
          <button
            @click="viewMode = 'list'"
            class="relative z-10 flex items-center justify-center w-8 h-7 rounded-full transition-colors duration-200 cursor-pointer"
            :class="viewMode === 'list' ? 'text-primary-text' : 'text-text-secondary hover:text-text'"
            title="List view"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
        <!-- Rendered before settings land so the toolbar doesn't reflow once
             they do. Until `loaded` flips we don't know whether update checks
             are on, so show the button disabled rather than guessing. -->
        <button
          v-if="!settingsStore.loaded || settingsStore.enableUpdateChecks"
          @click="handleUpdateButton"
          class="nav-btn relative"
          :disabled="updatesStore.checking || !settingsStore.loaded"
          :title="updateButtonTitle"
        >
          <svg v-if="updatesStore.checking" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <template v-else>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span v-if="updatesStore.updatesAvailableCount > 0" class="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 bg-warning text-white rounded-full text-[10px] font-bold">{{ updatesStore.updatesAvailableCount }}</span>
          </template>
        </button>
        <CreateMenu
          :stack-disabled="composeStore.composeActionsDisabled"
          :stack-disabled-reason="composeStore.composeDisabledReason"
          @select="handleCreate"
        />
      </div>
    </header>

    <main class="min-h-[200px]">
      <ComposeSetupBanner />
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
            @pull="handlePull"
            @update-folder="handleUpdateFolder"
            @edit-compose="openComposeEditor"
            @compose-up="openComposeUp"
            @compose-recompose="openComposeRecompose"
            @compose-pull="handleComposePull"
            @schedules="openSchedules"
          />
        </div>

        <!-- Unfoldered Containers -->
        <div v-if="filteredUnfolderedContainers.length > 0" class="mt-8">
          <div
            class="flex items-center gap-2 mb-4 cursor-pointer select-none"
            @click="unfolderedCollapsed = !unfolderedCollapsed"
          >
            <ChevronIcon :expanded="!unfolderedCollapsed" />
            <h2 class="text-sm font-semibold text-text">Unfoldered Containers</h2>
            <span class="inline-flex items-center justify-center min-w-6 h-6 px-2 bg-text-secondary text-white rounded-full text-xs font-semibold">{{
              filteredUnfolderedContainers.length
            }}</span>
          </div>

          <div class="expand-grid" :class="{ 'expand-expanded': !unfolderedCollapsed }">
            <div class="expand-inner">
              <div
                class="container-list"
                :class="viewMode === 'list' ? 'flex flex-col gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-4'"
                id="unfoldered-containers"
              >
                <ContainerCard
                  v-for="container in filteredUnfolderedContainers"
                  :key="container.id"
                  :container="container"
                  :action-in-progress="actionsInProgress.get(container.id) ?? null"
                  :view="viewMode"

                  @start="handleStart"
                  @stop="handleStop"
                  @restart="handleRestart"
                  @remove="handleRemove"
                  @pull="handlePull"
                  @schedules="openSchedules"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div v-if="dockerStore.containerCount === 0" class="text-center py-8 px-6 text-text-secondary">
          <p>No Docker containers found</p>
        </div>
      </div>
    </main>

    <!-- Schedule List Modal -->
    <ScheduleList
      :is-open="!!schedulesTarget"
      :target-type="schedulesTarget?.type ?? 'container'"
      :target-id="schedulesTarget?.id ?? ''"
      @close="schedulesTarget = null"
    />

    <!-- Folder Edit Modal -->
    <FolderEditModal :is-open="isModalOpen" :folder="editingFolder" @close="closeModal" @save="saveFolder" />

    <!-- Compose File Editor -->
    <ComposeFileEditor
      :is-open="composeEditorOpen"
      :project-name="composeEditorProject"
      :read-only="composeStore.composePluginInstalled && composeEditorMode !== 'create'"
      :mode="composeEditorMode"
      @close="composeEditorOpen = false"
      @recompose="openComposeRecompose"
    />

    <!-- Compose Start / Recompose / Pull Progress -->
    <ComposeProgressModal
      :is-open="composeProgressOpen"
      :project-name="composeProgressProject"
      :mode="composeProgressMode"
      :force-recreate="composeProgressForceRecreate"
      @close="closeComposeProgress"
      @complete="handleComposeProgressComplete"
    />

    <!-- Pull Progress Modal (single container) -->
    <PullProgressModal
      :is-open="!!pullingContainer"
      :image="pullingContainer?.image ?? ''"
      :container-name="pullingContainer?.name ?? ''"
      :managed="pullingContainer?.managed ?? null"
      @close="pullingContainer = null"
      @complete="handlePullComplete"
    />

    <!-- Batch Pull Progress Modal -->
    <BatchPullProgressModal
      :is-open="batchPullUnits.length > 0"
      :units="batchPullUnits"
      @close="handleBatchPullClose"
      @complete="handleBatchPullComplete"
    />

    <!-- BaseModal teleports its own overlay to the app root, so no wrapper needed -->
    <ConfirmModal
      :is-open="!!deletingFolderId"
      title="Delete Folder"
      :message="`Delete &quot;${deletingFolderName}&quot;? Containers will be moved to unfoldered.`"
      confirm-label="Delete"
      variant="danger"
      @confirm="confirmDeleteFolder"
      @cancel="deletingFolderId = null"
    />
    <UpdateConfirmModal
      :is-open="showBatchConfirm"
      :units="pendingUnits"
      :can-recheck="updateRecheckable"
      :checking="updatesStore.checking"
      @confirm="confirmBatchPull"
      @recheck="handleUpdateRecheck"
      @cancel="showBatchConfirm = false; pendingUnits = []"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick, provide, toRef } from 'vue';
import { useDockerStore, type Container } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { useUpdatesStore } from '@/stores/updates';
import { useComposeStore } from '@/stores/compose';
import { useScheduleStore } from '@/stores/schedules';
import { initWebSocket } from '@/composables/useWebSocket';
import FolderContainer from '@/components/folders/FolderContainer.vue';
import FolderEditModal from '@/components/folders/FolderEditModal.vue';
import ComposeSetupBanner from '@/components/compose/ComposeSetupBanner.vue';
import ComposeFileEditor from '@/components/compose/ComposeFileEditor.vue';
import ComposeProgressModal from '@/components/compose/ComposeProgressModal.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import ContainerCard from '@/components/docker/ContainerCard.vue';
import ChevronIcon from '@/components/common/ChevronIcon.vue';
import CreateMenu from '@/components/CreateMenu.vue';
import PullProgressModal from '@/components/docker/PullProgressModal.vue';
import BatchPullProgressModal from '@/components/docker/BatchPullProgressModal.vue';
import UpdateConfirmModal from '@/components/docker/UpdateConfirmModal.vue';
import { buildUpdateUnits, type UpdateUnit } from '@/utils/updateUnits';
import ScheduleList from '@/components/schedules/ScheduleList.vue';
import type { Folder, FolderCreateData, FolderUpdateData } from '@/types/folder';
import Sortable from 'sortablejs';

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const scheduleStore = useScheduleStore();
const settingsStore = useSettingsStore();
const statsStore = useStatsStore();
const updatesStore = useUpdatesStore();
const composeStore = useComposeStore();

const actionsInProgress = ref<Map<string, string>>(new Map());
const pullingContainer = ref<{ image: string; name: string; managed: string | null } | null>(null);
const batchPullUnits = ref<UpdateUnit[]>([]);
const showBatchConfirm = ref(false);
const pendingUnits = ref<UpdateUnit[]>([]);
/**
 * Whether the open confirm modal may offer "Check Again". Only true when it was
 * opened from the header, where the scope is every container. A folder or
 * single-container open is a *subset*, and a re-check rebuilds the list from
 * everything that has an update — which would silently widen that subset.
 */
const updateRecheckable = ref(false);
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

// Compose modal state
const composeEditorOpen = ref(false);
const composeEditorMode = ref<'edit' | 'create'>('edit');
const composeEditorProject = ref('');

// Compose progress modal (start/recompose)
const composeProgressProject = ref('');
const composeProgressMode = ref<'up' | 'pull'>('up');
const composeProgressForceRecreate = ref(false);
const composeProgressOpen = ref(false);

function openComposeEditor(project: string) {
  composeEditorProject.value = project;
  composeEditorMode.value = 'edit';
  composeEditorOpen.value = true;
}

function openCreateStack() {
  composeEditorProject.value = '';
  composeEditorMode.value = 'create';
  composeEditorOpen.value = true;
}

// "Container" is an anchor inside CreateMenu — it navigates the parent document
// rather than emitting, so it never reaches here.
function handleCreate(action: 'stack' | 'folder') {
  if (action === 'stack') openCreateStack();
  else openCreateFolderModal();
}

function openComposeUp(project: string) {
  composeProgressProject.value = project;
  composeProgressMode.value = 'up';
  composeProgressForceRecreate.value = false;
  composeProgressOpen.value = true;
}

function openComposeRecompose(project: string) {
  composeProgressProject.value = project;
  composeProgressMode.value = 'up';
  composeProgressForceRecreate.value = true;
  composeProgressOpen.value = true;
}

// Pull streams its output into the same progress modal as up/recompose —
// a bare await gave no sign anything was happening.
function handleComposePull(project: string) {
  composeProgressProject.value = project;
  composeProgressMode.value = 'pull';
  composeProgressForceRecreate.value = false;
  composeProgressOpen.value = true;
}

async function handleComposeProgressComplete() {
  // A pull only changes image digests on disk — nothing is created, started or
  // stopped — so the container list and folder assignments are unchanged.
  // fetchContainers() is the most expensive call the plugin makes (a Docker
  // socket enumeration plus a scan of Unraid's template directory), so don't
  // pay for it here.
  if (composeProgressMode.value === 'pull') {
    await composeStore.fetchStacks(true);
    return;
  }

  await Promise.all([
    dockerStore.fetchContainers(),
    folderStore.fetchFolders(),
    composeStore.fetchStacks(true),
  ]);
}

function closeComposeProgress() {
  composeProgressOpen.value = false;
  composeProgressProject.value = '';
  composeProgressMode.value = 'up';
  composeProgressForceRecreate.value = false;
}

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
    await Promise.all([dockerStore.fetchContainers(), folderStore.fetchFolders(), settingsStore.fetchSettings(), composeStore.fetchStatus(), scheduleStore.fetchSchedules()]);
    if (settingsStore.enableUpdateChecks) {
      await updatesStore.fetchCachedUpdates();
    }
    // Load compose stacks after containers (needs compose_project labels)
    await composeStore.fetchStacks();
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
          // Revert SortableJS DOM move — let Vue reactivity handle rendering
          evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex ?? 0] || null);

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
          // Revert SortableJS DOM move — let Vue reactivity handle rendering
          evt.from.insertBefore(evt.item, evt.from.children[evt.oldIndex ?? 0] || null);

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

const schedulesTarget = ref<{ type: 'container' | 'stack'; id: string } | null>(null);

function openSchedules(targetType: string, targetId: string) {
  schedulesTarget.value = { type: targetType as 'container' | 'stack', id: targetId };
}

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

async function handleRemove(id: string, removeImage = false) {
  actionsInProgress.value.set(id, 'remove');
  try {
    await dockerStore.removeContainer(id, removeImage);
  } finally {
    actionsInProgress.value.delete(id);
  }
}

function handlePull(data: { image: string; name: string; managed: string | null }) {
  // Pulling an image recreates *every* container using it. When this container
  // is the only one, go straight to the pull; when it has siblings, show them
  // first so nothing gets recreated invisibly.
  const container = dockerStore.containers.find((c) => c.name === data.name);
  if (container) {
    const units = buildUpdateUnits(
      [container],
      dockerStore.containers,
      composeStore.managementEnabled,
    );
    const affected = units.reduce((total, u) => total + u.containers.length, 0);
    if (affected > 1) {
      pendingUnits.value = units;
      showBatchConfirm.value = true;
      return;
    }
  }
  pullingContainer.value = data;
}

async function handlePullComplete(image: string) {
  updatesStore.clearUpdateForImage(image);
  await dockerStore.fetchContainers(true);
  await updatesStore.fetchCachedUpdates();
}

function openUpdateConfirm(containers: Container[]) {
  if (containers.length === 0) return;
  const units = buildUpdateUnits(
    containers,
    dockerStore.containers,
    composeStore.managementEnabled,
  );
  if (units.length === 0) return;
  updateRecheckable.value = false;
  pendingUnits.value = units;
  showBatchConfirm.value = true;
}

/**
 * The header's update button does one of two things depending on what we know:
 * with no updates on record it runs a check, and with updates on record it
 * opens the confirm list. One button, because "check" and "review what the
 * check found" are the same intent a moment apart.
 */
function handleUpdateButton() {
  if (updatesStore.updatesAvailableCount > 0) {
    handleUpdateAll();
    return;
  }
  updatesStore.checkForUpdates();
}

const updateButtonTitle = computed(() => {
  if (!settingsStore.loaded) return 'Loading settings…';
  if (updatesStore.checking) return 'Checking for image updates…';
  const n = updatesStore.updatesAvailableCount;
  if (n === 0) return 'Check for image updates';
  return n === 1 ? 'Review 1 available update' : `Review ${n} available updates`;
});

function handleUpdateAll() {
  const containers = updatesStore.getContainersWithUpdates();
  if (containers.length === 0) return;
  const units = buildUpdateUnits(
    containers,
    dockerStore.containers,
    composeStore.managementEnabled,
  );
  if (units.length === 0) return;
  updateRecheckable.value = true;
  pendingUnits.value = units;
  showBatchConfirm.value = true;
}

/**
 * "Check Again" from inside the open modal. Rebuilds the list from whatever the
 * fresh check found, so containers that gained an update appear and ones that
 * no longer have one drop out. An empty result leaves the modal open on its
 * "everything is up to date" state rather than closing under the user.
 */
async function handleUpdateRecheck() {
  await updatesStore.checkForUpdates();
  pendingUnits.value = buildUpdateUnits(
    updatesStore.getContainersWithUpdates(),
    dockerStore.containers,
    composeStore.managementEnabled,
  );
}

function handleUpdateFolder(folder: Folder) {
  const containersWithUpdates: Container[] = [];
  for (const assoc of folder.containers) {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    if (container && updatesStore.hasUpdate(container.image)) {
      containersWithUpdates.push(container);
    }
  }
  openUpdateConfirm(containersWithUpdates);
}

function confirmBatchPull(units: UpdateUnit[]) {
  showBatchConfirm.value = false;
  batchPullUnits.value = units;
  pendingUnits.value = [];
}

async function handleBatchPullComplete() {
  // Refresh data after batch pull completes
  await dockerStore.fetchContainers(true);
  await updatesStore.fetchCachedUpdates();
  await recheckComposeImages();
}

/**
 * Re-check images updated through the compose CLI.
 *
 * `pull.php` records fresh digests itself, so image units clear their own
 * update flag. `compose-stream.php` doesn't — without this, a stack updated
 * via `docker compose` keeps showing an "Update" badge until the next
 * scheduled check.
 */
async function recheckComposeImages() {
  const images = new Set<string>();
  for (const unit of batchPullUnits.value) {
    if (unit.kind !== 'compose') continue;
    for (const container of unit.containers) images.add(container.image);
  }
  if (images.size === 0) return;
  await updatesStore.checkImagesForUpdates([...images]);
}

function handleBatchPullClose() {
  batchPullUnits.value = [];
  // Clear update flags for successfully pulled images
  dockerStore.fetchContainers(true);
  updatesStore.fetchCachedUpdates();
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
