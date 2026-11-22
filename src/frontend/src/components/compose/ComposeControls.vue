<template>
  <div class="flex items-center gap-1 min-w-0" @click.stop>
    <!-- Stack Up (show when not fully running) -->
    <button
      v-if="!isFullyRunning"
      :disabled="composeStore.stackActionsDisabled(projectName)"
      :title="buttonTitle('Start stack')"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-success disabled:opacity-40 disabled:cursor-not-allowed"
      @click="$emit('compose-up', projectName)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3" /></svg>
    </button>

    <!-- Recompose (show when stack has running services) -->
    <button
      v-if="isRunning"
      :disabled="composeStore.stackActionsDisabled(projectName)"
      :title="buttonTitle('Recompose (pull + recreate)')"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-info disabled:opacity-40 disabled:cursor-not-allowed"
      @click="$emit('compose-recompose', projectName)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>

    <!-- Stack Down (show when has running services) -->
    <button
      v-if="isRunning || removing"
      :disabled="composeStore.stackActionsDisabled(projectName)"
      :title="buttonTitle('Stack Down (delete containers)')"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-error disabled:opacity-40 disabled:cursor-not-allowed"
      @click="$emit('compose-down', projectName)"
    >
      <svg v-if="removing" class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
      <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
    </button>

    <!-- Schedules -->
    <button
      title="Schedules"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-text"
      @click="$emit('schedules', 'stack', projectName)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
    </button>

    <!-- Edit stack (compose file + logs tab) -->
    <button
      :title="composeStore.composePluginInstalled ? 'View stack (read-only, compose.manager installed)' : 'Edit stack'"
      class="p-1 rounded cursor-pointer transition text-text-secondary hover:text-info"
      @click="$emit('edit-compose', projectName)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>
    </button>
    <span
      v-if="failure"
      class="text-[11px] text-error truncate max-w-[240px] cursor-pointer"
      :title="`${stackActionText(failure)} (click to dismiss)`"
      @click="composeStore.clearStackStatus(projectName)"
    >{{ stackActionLabel(failure.kind) }} failed: {{ stackActionText(failure) }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useComposeStore, stackActionText, stackActionLabel } from '@/stores/compose';
import { useFolderRunningState } from '@/composables/useFolderRunningState';
import type { Folder } from '@/types/folder';

const props = defineProps<{
  projectName: string;
  folder?: Folder;
}>();

defineEmits<{
  'edit-compose': [project: string];
  'compose-up': [project: string];
  'compose-recompose': [project: string];
  'compose-down': [project: string];
  schedules: [targetType: string, targetId: string];
}>();

const composeStore = useComposeStore();

// Stop and down state is shared with the stacks pane (composeStore.runStackAction).
const status = computed(() => composeStore.stackActionStatus.get(props.projectName));
const removing = computed(() => status.value?.kind === 'down' && composeStore.isStackBusy(props.projectName));
const failure = computed(() => (status.value?.error !== undefined ? status.value : null));

// Drive running state from actual docker containers, not compose metadata,
// so a stack with zero running containers never shows as running.
const { isRunning, isFullyRunning } = useFolderRunningState(() => props.folder);

function buttonTitle(defaultTitle: string): string {
  return composeStore.stackDisabledReason(props.projectName) ?? defaultTitle;
}
</script>
