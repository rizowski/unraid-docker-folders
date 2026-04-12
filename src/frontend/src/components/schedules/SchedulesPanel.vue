<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <h2 class="text-base font-semibold text-text m-0 flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        </svg>
        Schedules
        <span v-if="scheduleStore.scheduleCount" class="text-xs text-text-secondary font-normal">({{ scheduleStore.scheduleCount }})</span>
      </h2>
      <div class="flex items-center gap-2">
        <input
          v-model="filter"
          placeholder="Filter..."
          class="px-2 py-1 rounded border border-border bg-bg text-text text-sm w-40"
        />
      </div>
    </div>

    <div v-if="scheduleStore.loading && !scheduleStore.schedules.length" class="text-sm text-text-secondary py-4 text-center">
      Loading schedules...
    </div>

    <div v-else-if="!filteredSchedules.length" class="text-sm text-text-secondary py-4 text-center">
      {{ filter ? 'No matching schedules' : 'No schedules configured' }}
    </div>

    <div v-else class="flex flex-col gap-1">
      <div
        v-for="schedule in filteredSchedules"
        :key="schedule.id"
        class="flex items-center gap-3 p-3 rounded border border-border bg-bg-card"
      >
        <input
          type="checkbox"
          :checked="schedule.enabled"
          class="cursor-pointer shrink-0"
          @change="scheduleStore.toggleSchedule(schedule.id, !schedule.enabled)"
        />

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-medium text-text">{{ schedule.name }}</span>
            <span class="text-xs px-1.5 py-0.5 rounded bg-bg text-text-secondary">{{ schedule.action }}</span>
            <span class="text-xs text-text-secondary">{{ schedule.target_type }}: {{ schedule.target_id }}</span>
          </div>
          <div class="text-xs text-text-secondary mt-0.5">
            <span v-if="schedule.next_run_at">Next: {{ formatTime(schedule.next_run_at) }}</span>
            <span v-if="schedule.last_run_status" class="ml-2">
              Last: <span :class="statusClass(schedule.last_run_status)">{{ schedule.last_run_status }}</span>
              <span v-if="schedule.last_run_at" class="ml-1">({{ formatTime(schedule.last_run_at) }})</span>
            </span>
          </div>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <button
            class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-primary transition bg-transparent border-none"
            title="Run now"
            @click="scheduleStore.runScheduleNow(schedule.id)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 4l14 8-14 8z" /></svg>
          </button>
          <button
            class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-text transition bg-transparent border-none"
            title="History"
            @click="showHistory = schedule.id"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>
          </button>
          <button
            class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-text transition bg-transparent border-none"
            title="Edit"
            @click="editTarget = { id: schedule.id, type: schedule.target_type as TargetType, targetId: schedule.target_id }"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>
          <button
            class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-error transition bg-transparent border-none"
            title="Delete"
            @click="confirmDelete = schedule.id"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          </button>
        </div>
      </div>
    </div>

    <ScheduleModal
      v-if="editTarget"
      :is-open="!!editTarget"
      :target-type="editTarget.type"
      :target-id="editTarget.targetId"
      :edit-id="editTarget.id"
      @close="editTarget = null"
      @saved="editTarget = null"
    />

    <ScheduleHistoryModal
      v-if="showHistory !== null"
      :is-open="showHistory !== null"
      :schedule-id="showHistory!"
      @close="showHistory = null"
    />

    <ConfirmModal
      :is-open="confirmDelete !== null"
      title="Delete Schedule"
      message="Are you sure you want to delete this schedule?"
      confirm-label="Delete"
      variant="danger"
      @confirm="doDelete"
      @cancel="confirmDelete = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import ScheduleModal from './ScheduleModal.vue';
import ScheduleHistoryModal from './ScheduleHistoryModal.vue';
import { useScheduleStore } from '@/stores/schedules';
import { formatTimestamp, scheduleStatusClass } from '@/utils/format';
import type { TargetType } from '@/types/schedule';

const scheduleStore = useScheduleStore();

const filter = ref('');
const showHistory = ref<number | null>(null);
const editTarget = ref<{ id: number; type: TargetType; targetId: string } | null>(null);
const confirmDelete = ref<number | null>(null);

const formatTime = formatTimestamp;
const statusClass = scheduleStatusClass;

const filteredSchedules = computed(() => {
  const q = filter.value.toLowerCase();
  if (!q) return scheduleStore.schedules;
  return scheduleStore.schedules.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.target_id.toLowerCase().includes(q) ||
      s.action.includes(q),
  );
});

async function doDelete() {
  if (confirmDelete.value !== null) {
    await scheduleStore.deleteSchedule(confirmDelete.value);
    confirmDelete.value = null;
  }
}

onMounted(() => {
  scheduleStore.fetchSchedules();
});
</script>
