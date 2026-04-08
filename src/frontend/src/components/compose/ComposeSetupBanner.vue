<template>
  <!-- Binary not installed banner -->
  <div v-if="!composeStore.composeAvailable" class="flex items-center gap-3 px-4 py-3 mb-4 rounded bg-warning/10 border border-warning/30 text-sm">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-warning shrink-0">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span class="text-text flex-1">Docker Compose is not installed. Install it to manage compose stacks.</span>
    <button
      @click="install"
      :disabled="composeStore.installingBinary"
      class="px-4 py-1.5 rounded text-sm font-medium cursor-pointer bg-warning text-white border-none hover:brightness-90 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
    >
      <template v-if="composeStore.installingBinary">
        <svg class="animate-spin h-4 w-4 inline-block mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        Installing...
      </template>
      <template v-else>Install Docker Compose</template>
    </button>
  </div>

  <!-- Compose plugin conflict banner -->
  <div v-if="composeStore.composePluginInstalled" class="flex items-center gap-3 px-4 py-3 mb-4 rounded bg-blue-500/10 border border-blue-500/30 text-sm">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-blue-400 shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
    <span class="text-text flex-1">Compose Manager plugin is installed. Stack management is read-only — uninstall it to manage stacks here.</span>
  </div>

  <!-- Compose plugin data migration banner -->
  <div v-if="showImportBanner" class="flex items-center gap-3 px-4 py-3 mb-4 rounded bg-primary/10 border border-primary/30 text-sm">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary shrink-0">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
    <span class="text-text flex-1">Compose Manager plugin data detected. Import your existing stacks?</span>
    <button
      @click="handleImport"
      :disabled="importing"
      class="px-4 py-1.5 rounded text-sm font-medium cursor-pointer bg-primary text-primary-text border-none hover:brightness-90 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
    >
      {{ importing ? 'Importing...' : 'Import Stacks' }}
    </button>
    <button
      @click="dismissImport"
      class="px-3 py-1.5 rounded text-sm font-medium cursor-pointer bg-border text-text border-none hover:brightness-90 transition shrink-0"
    >Dismiss</button>
  </div>

  <!-- Import result -->
  <div v-if="importResult" class="flex items-center gap-2 px-4 py-2 mb-4 rounded text-sm" :class="importResult.success ? 'bg-green-500/10 border border-green-500/30 text-green-400' : 'bg-error/10 border border-error/30 text-error'">
    <template v-if="importResult.success">
      Imported {{ importResult.stacks_imported }} stack(s), {{ importResult.stacks_skipped }} skipped.
    </template>
    <template v-else>
      Import failed: {{ importResult.errors?.join(', ') || 'Unknown error' }}
    </template>
  </div>

  <!-- Install error -->
  <div v-if="installError" class="flex items-center gap-2 px-4 py-2 mb-4 rounded bg-error/10 border border-error/30 text-sm text-error">
    {{ installError }}
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useComposeStore } from '@/stores/compose';
import type { ComposeImportResult } from '@/types/compose';

const composeStore = useComposeStore();
const installError = ref<string | null>(null);
const importDismissed = ref(false);
const importing = ref(false);
const importResult = ref<ComposeImportResult | null>(null);

const showImportBanner = computed(() =>
  composeStore.status.compose_plugin_data_exists &&
  !composeStore.composePluginInstalled &&
  !importDismissed.value &&
  !importResult.value
);

async function install() {
  installError.value = null;
  const success = await composeStore.installBinary();
  if (!success) {
    installError.value = composeStore.error || 'Failed to install Docker Compose';
  }
}

async function handleImport() {
  importing.value = true;
  try {
    importResult.value = await composeStore.importFromComposePlugin();
    // Refresh containers + folders so syncComposeStacks can associate
    // any running compose containers with the newly created folders
    const { useDockerStore } = await import('@/stores/docker');
    const { useFolderStore } = await import('@/stores/folders');
    await Promise.all([
      useDockerStore().fetchContainers(),
      useFolderStore().fetchFolders(),
    ]);
  } finally {
    importing.value = false;
  }
}

function dismissImport() {
  importDismissed.value = true;
}
</script>
