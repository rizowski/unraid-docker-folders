<template>
  <div class="flex items-center gap-1" @click.stop>
    <!-- Stack Up (show when not fully running) -->
    <button
      v-if="!isFullyRunning || actionInProgress === 'up'"
      :disabled="!composeStore.managementEnabled || actionInProgress !== null"
      :title="buttonTitle('Start stack')"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-green-400 disabled:opacity-40 disabled:cursor-not-allowed"
      @click="handleUp"
    >
      <svg v-if="actionInProgress === 'up'" class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
      <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
    </button>

    <!-- Stack Down (show when has running services) -->
    <button
      v-if="isRunning || actionInProgress === 'down'"
      :disabled="!composeStore.managementEnabled || actionInProgress !== null"
      :title="buttonTitle('Stop stack')"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed"
      @click="handleDown"
    >
      <svg v-if="actionInProgress === 'down'" class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
      <!-- Square stop icon -->
      <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
    </button>

    <!-- Edit Compose -->
    <button
      :title="composeStore.composePluginInstalled ? 'View compose file (read-only, compose.manager installed)' : 'Edit compose file'"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="actionInProgress !== null"
      @click="$emit('edit-compose', projectName)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
    </button>

    <!-- Logs -->
    <button
      title="View stack logs"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
      :disabled="actionInProgress !== null"
      @click="$emit('view-logs', projectName)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
    </button>

    <ComposeStartProgressModal
      :is-open="startModalOpen"
      :project-name="projectName"
      @close="handleStartModalClose"
      @complete="handleStartComplete"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useComposeStore } from '@/stores/compose';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import ComposeStartProgressModal from './ComposeStartProgressModal.vue';

const props = defineProps<{
  projectName: string;
}>();

defineEmits<{
  'edit-compose': [project: string];
  'view-logs': [project: string];
}>();

const composeStore = useComposeStore();
const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const actionInProgress = ref<string | null>(null);
const startModalOpen = ref(false);

const stack = computed(() => composeStore.getStackByProject(props.projectName));
const isRunning = computed(() => (stack.value?.services_running ?? 0) > 0);
const isFullyRunning = computed(() => {
  const s = stack.value;
  if (!s || s.services_total === 0) return false;
  return s.services_running >= s.services_total;
});

function buttonTitle(defaultTitle: string): string {
  if (!composeStore.composeAvailable) return 'Docker Compose not installed';
  if (composeStore.composePluginInstalled) return 'Disabled: compose.manager plugin is installed';
  return defaultTitle;
}

function handleUp() {
  if (!composeStore.managementEnabled || actionInProgress.value !== null) return;
  actionInProgress.value = 'up';
  startModalOpen.value = true;
}

async function handleStartComplete() {
  // Refresh so syncComposeStacks associates containers with folders
  await Promise.all([
    dockerStore.fetchContainers(),
    folderStore.fetchFolders(),
    composeStore.fetchStacks(true),
  ]);
}

function handleStartModalClose() {
  startModalOpen.value = false;
  actionInProgress.value = null;
}

async function handleDown() {
  actionInProgress.value = 'down';
  try {
    await composeStore.stackDown(props.projectName);
    // Refresh to update container/folder state
    await Promise.all([
      dockerStore.fetchContainers(),
      folderStore.fetchFolders(),
    ]);
  } finally {
    actionInProgress.value = null;
  }
}
</script>
