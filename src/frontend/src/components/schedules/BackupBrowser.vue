<template>
  <BaseModal :is-open="isOpen" max-width="600px" @close="$emit('close')">
    <div class="p-5 flex flex-col gap-3">
      <h2 class="text-lg font-semibold text-text m-0">Backups: {{ targetId }}</h2>

      <div v-if="loading" class="text-sm text-text-secondary py-4 text-center">Loading...</div>

      <div v-else-if="!backups.length" class="text-sm text-text-secondary py-4 text-center">
        No backups found
      </div>

      <div v-else class="flex flex-col gap-1 max-h-[400px] overflow-auto">
        <div
          v-for="backup in backups"
          :key="backup.path"
          class="flex items-center gap-3 p-2.5 rounded border border-border text-sm"
        >
          <div class="flex-1 min-w-0">
            <div class="text-text font-mono text-xs truncate">{{ backup.filename }}</div>
            <div class="text-xs text-text-secondary mt-0.5">
              {{ formatSize(backup.size) }} &middot; {{ formatTime(backup.created_at) }}
            </div>
          </div>
          <button
            class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-error transition bg-transparent border-none shrink-0"
            title="Delete backup"
            @click="confirmDeletePath = backup.path"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          </button>
        </div>
      </div>

      <ConfirmModal
        :is-open="!!confirmDeletePath"
        title="Delete Backup"
        message="Are you sure you want to delete this backup file?"
        confirm-label="Delete"
        variant="danger"
        @confirm="doDelete"
        @cancel="confirmDeletePath = ''"
      />

      <div class="flex justify-end pt-2">
        <button class="px-4 py-2 rounded border border-border bg-transparent text-text text-sm cursor-pointer hover:bg-bg" @click="$emit('close')">Close</button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import { useScheduleStore } from '@/stores/schedules';
import { formatTimestamp, formatBytes } from '@/utils/format';
import type { BackupEntry } from '@/types/schedule';

interface Props {
  isOpen: boolean;
  targetType: string;
  targetId: string;
}

const props = defineProps<Props>();
defineEmits<{ close: [] }>();

const scheduleStore = useScheduleStore();
const backups = ref<BackupEntry[]>([]);
const loading = ref(true);
const confirmDeletePath = ref('');

const formatTime = formatTimestamp;
const formatSize = formatBytes;

async function loadBackups() {
  loading.value = true;
  backups.value = await scheduleStore.getBackups(props.targetType, props.targetId);
  loading.value = false;
}

async function doDelete() {
  if (confirmDeletePath.value) {
    await scheduleStore.deleteBackup(confirmDeletePath.value);
    confirmDeletePath.value = '';
    await loadBackups();
  }
}

onMounted(loadBackups);
</script>
