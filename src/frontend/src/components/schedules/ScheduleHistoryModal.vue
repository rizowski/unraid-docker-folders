<template>
  <BaseModal :is-open="isOpen" max-width="600px" @close="$emit('close')">
    <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border">
      <h2 class="text-xl font-semibold text-text m-0">Execution History</h2>
      <button
        class="icon-btn icon-btn-round text-text-secondary hover:text-text"
        aria-label="Close"
        @click="$emit('close')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div class="p-4 sm:p-6 flex flex-col gap-3">
      <div v-if="loading" class="text-sm text-text-secondary py-4 text-center">Loading...</div>

      <div v-else-if="!history.length" class="text-sm text-text-secondary py-4 text-center">
        No execution history yet
      </div>

      <div v-else class="flex flex-col gap-1 max-h-[400px] overflow-auto">
        <div
          v-for="entry in history"
          :key="entry.id"
          class="flex items-center gap-3 p-2.5 rounded border border-border text-sm"
        >
          <span
            class="w-2 h-2 rounded-full shrink-0"
            :class="{
              'bg-success': entry.status === 'success',
              'bg-error': entry.status === 'error',
              'bg-warning': entry.status === 'running',
              'bg-text-secondary': entry.status === 'skipped',
            }"
          ></span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-text">{{ formatTime(entry.started_at) }}</span>
              <span v-if="entry.finished_at" class="text-text-secondary text-xs">
                ({{ duration(entry.started_at, entry.finished_at) }})
              </span>
            </div>
            <div v-if="entry.message" class="text-xs text-text-secondary truncate mt-0.5">{{ entry.message }}</div>
            <div v-if="entry.backup_file" class="text-xs text-text-secondary mt-0.5">
              {{ entry.backup_file }} ({{ formatSize(entry.backup_size || 0) }})
            </div>
          </div>
          <span class="text-xs px-1.5 py-0.5 rounded shrink-0" :class="statusBadge(entry.status)">
            {{ entry.status }}
          </span>
        </div>
      </div>

    </div>

    <div class="flex justify-end p-4 sm:p-6 pt-4 border-t border-border">
      <button class="nav-btn" @click="$emit('close')">Close</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useScheduleStore } from '@/stores/schedules';
import { formatTimestamp, formatDuration, formatBytes } from '@/utils/format';
import type { ScheduleHistoryEntry } from '@/types/schedule';

interface Props {
  isOpen: boolean;
  scheduleId: number;
}

const props = defineProps<Props>();
defineEmits<{ close: [] }>();

const scheduleStore = useScheduleStore();
const history = ref<ScheduleHistoryEntry[]>([]);
const loading = ref(true);

const formatTime = formatTimestamp;
const duration = formatDuration;
const formatSize = formatBytes;

function statusBadge(status: string) {
  switch (status) {
    case 'success': return 'bg-success/20 text-success';
    case 'error': return 'bg-error/20 text-error';
    case 'running': return 'bg-warning/20 text-warning';
    default: return 'bg-bg text-text-secondary';
  }
}

onMounted(async () => {
  loading.value = true;
  history.value = await scheduleStore.getHistory(props.scheduleId);
  loading.value = false;
});
</script>
