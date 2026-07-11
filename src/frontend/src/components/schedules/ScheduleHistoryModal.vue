<template>
  <BaseModal :is-open="isOpen" max-width="600px" @close="$emit('close')">
    <div class="p-5 flex flex-col gap-3">
      <h2 class="text-lg font-semibold text-text m-0">Execution History</h2>

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
              'bg-yellow-500': entry.status === 'running',
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

      <div class="flex justify-end pt-2">
        <button class="px-4 py-2 rounded border border-border bg-transparent text-text text-sm cursor-pointer hover:bg-bg" @click="$emit('close')">Close</button>
      </div>
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
    case 'running': return 'bg-yellow-500/20 text-yellow-500';
    default: return 'bg-bg text-text-secondary';
  }
}

onMounted(async () => {
  loading.value = true;
  history.value = await scheduleStore.getHistory(props.scheduleId);
  loading.value = false;
});
</script>
