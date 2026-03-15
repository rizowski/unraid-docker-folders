<template>
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
  <div v-if="installError" class="flex items-center gap-2 px-4 py-2 mb-4 rounded bg-error/10 border border-error/30 text-sm text-error">
    {{ installError }}
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useComposeStore } from '@/stores/compose';

const composeStore = useComposeStore();
const installError = ref<string | null>(null);

async function install() {
  installError.value = null;
  const success = await composeStore.installBinary();
  if (!success) {
    installError.value = composeStore.error || 'Failed to install Docker Compose';
  }
}
</script>
