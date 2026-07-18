<template>
  <div class="mb-1">
    <FolderHeader :folder="folder" :hide-stopped="hideStopped" :hidden-count="hiddenCount" @toggle-collapse="toggleCollapse" @toggle-hide-stopped="hideStopped = !hideStopped" @edit="$emit('edit', folder)" @delete="$emit('delete', folder.id)" @update-folder="$emit('update-folder', folder)" @edit-compose="(p) => emit('edit-compose', p)" @compose-up="(p) => emit('compose-up', p)" @compose-recompose="(p) => emit('compose-recompose', p)" @compose-pull="(p) => emit('compose-pull', p)" @schedules="(type, id) => emit('schedules', type, id)" />

    <div class="expand-grid" :class="{ 'expand-expanded': isExpanded, 'expand-settled': expandSettled }">
      <div class="expand-inner px-2 sm:px-4">
        <div
          class="container-list"
          :class="[
            view === 'list' ? 'flex flex-col gap-1.5' : 'grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-3',
            folderContainers.length > 0 ? 'mb-2 min-h-[60px]' : '',
          ]"
          :data-folder-id="folder.id"
        >
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
            @schedules="(type, id) => emit('schedules', type, id)"
          />
        </div>
        <!-- Compose folder: stack down — show faded service names as a preview -->
        <div
          v-if="folderContainers.length === 0 && folder.compose_project && previewAssociations.length > 0"
          class="mb-2 opacity-40 pointer-events-none select-none"
          :class="view === 'list' ? 'flex flex-col gap-1.5' : 'grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-3'"
        >
          <div
            v-for="name in previewAssociations"
            :key="name"
            class="flex items-center gap-2 px-3 py-2 bg-bg-card border border-border rounded"
          >
            <span class="w-2 h-2 rounded-full bg-text-secondary shrink-0"></span>
            <span class="text-sm text-text truncate">{{ name }}</span>
            <span class="ml-auto text-[10px] uppercase tracking-wide text-text-secondary">stopped</span>
          </div>
        </div>
        <div
          v-else-if="folderContainers.length === 0 && !folder.compose_project"
          class="text-center py-6 text-text-secondary border-2 border-dashed border-border rounded mb-2"
        >
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
import { useComposeStore } from '@/stores/compose';
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
  'edit-compose': [project: string];
  'compose-up': [project: string];
  'compose-recompose': [project: string];
  'compose-pull': [project: string];
  schedules: [targetType: string, targetId: string];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const composeStore = useComposeStore();
const statsStore = useStatsStore();
const settingsStore = useSettingsStore();
const actionsInProgress = ref<Map<string, string>>(new Map());

const storageKey = computed(() => `docker-folders-hide-stopped-${props.folder.id}`);
const hideStopped = ref(localStorage.getItem(`docker-folders-hide-stopped-${props.folder.id}`) === '1');
watch(hideStopped, (v) => localStorage.setItem(storageKey.value, v ? '1' : '0'));

const isSearching = computed(() => dockerStore.searchQuery.trim().length > 0);

const isExpanded = computed(() => !props.folder.collapsed || isSearching.value);

// Overflow on the expand container must stay hidden while the height
// transition runs (see .expand-settled in main.css), so mark the folder as
// settled shortly after the 200ms transition finishes. Collapse unsettles
// immediately so the closing transition can animate.
const expandSettled = ref(isExpanded.value);
let settleTimer: ReturnType<typeof setTimeout> | undefined;
watch(isExpanded, (expanded) => {
  clearTimeout(settleTimer);
  if (expanded) {
    settleTimer = setTimeout(() => {
      expandSettled.value = true;
    }, 220);
  } else {
    expandSettled.value = false;
  }
});
onUnmounted(() => clearTimeout(settleTimer));

const folderContainers = computed(() => {
  let list = props.folder.containers || [];
  // Filter out associations where the container no longer exists in Docker
  // (e.g. after docker compose down removes containers)
  list = list.filter((assoc) => !!getContainer(assoc.container_name));
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

// Preview list for compose folders whose stack is down.
// Prefer the service names defined in the compose file (works even when
// the stack has been fully removed via `docker compose down`); fall back
// to stored container_folders rows if we have no stack metadata yet.
const previewAssociations = computed(() => {
  if (!props.folder.compose_project) return [];
  const stack = composeStore.getStackByProject(props.folder.compose_project);
  let names: string[];
  if (stack?.service_names && stack.service_names.length > 0) {
    names = stack.service_names;
  } else {
    names = (props.folder.containers || []).map((a) => a.container_name);
  }
  if (isSearching.value) {
    const q = dockerStore.searchQuery.trim().toLowerCase();
    names = names.filter((name) => name.toLowerCase().includes(q));
  }
  return names;
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

async function handleRemove(id: string, removeImage = false) {
  actionsInProgress.value.set(id, 'remove');
  try {
    await dockerStore.removeContainer(id, removeImage);
  } finally {
    actionsInProgress.value.delete(id);
  }
}
</script>
