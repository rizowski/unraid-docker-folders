<template>
  <BaseModal :is-open="isOpen" max-width="640px" @close="$emit('close')">
    <div class="p-5 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-text m-0">Schedules: {{ targetId }}</h2>
        <button class="px-3 py-1.5 rounded border-none bg-primary text-white text-sm cursor-pointer hover:opacity-90" @click="showCreateModal = true">
          + Add
        </button>
      </div>

      <div v-if="loading" class="text-sm text-text-secondary py-4 text-center">Loading...</div>

      <div v-else-if="!targetSchedules.length" class="text-sm text-text-secondary py-4 text-center">
        No schedules for this {{ targetType }}
      </div>

      <div v-else class="flex flex-col gap-2">
        <div
          v-for="schedule in targetSchedules"
          :key="schedule.id"
          class="flex items-center gap-3 p-3 rounded border border-border bg-bg"
        >
          <div class="flex items-center">
            <input
              type="checkbox"
              :checked="schedule.enabled"
              class="cursor-pointer"
              @change="scheduleStore.toggleSchedule(schedule.id, !schedule.enabled)"
            />
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-text truncate">{{ schedule.name }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded bg-bg-card text-text-secondary shrink-0">{{ schedule.action }}</span>
            </div>
            <div class="text-xs text-text-secondary mt-0.5">
              <span v-if="schedule.next_run_at">Next: {{ formatTime(schedule.next_run_at) }}</span>
              <span v-if="schedule.last_run_status" class="ml-2">
                Last:
                <span :class="statusClass(schedule.last_run_status)">{{ schedule.last_run_status }}</span>
              </span>
            </div>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <button
              class="p-1.5 rounded cursor-pointer text-text-secondary hover:text-primary transition bg-transparent border-none"
              title="Run now"
              @click="runNow(schedule.id)"
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
              @click="editSchedule = schedule.id"
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
        :is-open="showCreateModal || editSchedule !== null"
        :target-type="targetType"
        :target-id="targetId"
        :edit-id="editSchedule"
        @close="showCreateModal = false; editSchedule = null"
        @saved="onSaved"
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
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import ScheduleModal from './ScheduleModal.vue';
import ScheduleHistoryModal from './ScheduleHistoryModal.vue';
import { useScheduleStore } from '@/stores/schedules';
import { formatTimestamp, scheduleStatusClass } from '@/utils/format';
import type { TargetType } from '@/types/schedule';

interface Props {
  isOpen: boolean;
  targetType: TargetType;
  targetId: string;
}

const props = defineProps<Props>();
defineEmits<{ close: [] }>();

const scheduleStore = useScheduleStore();
const loading = computed(() => scheduleStore.loading);

const showCreateModal = ref(false);
const editSchedule = ref<number | null>(null);
const showHistory = ref<number | null>(null);
const confirmDelete = ref<number | null>(null);

const targetSchedules = computed(() =>
  scheduleStore.schedulesForTarget(props.targetType, props.targetId),
);

const formatTime = formatTimestamp;
const statusClass = scheduleStatusClass;

async function runNow(id: number) {
  await scheduleStore.runScheduleNow(id);
}

async function doDelete() {
  if (confirmDelete.value !== null) {
    await scheduleStore.deleteSchedule(confirmDelete.value);
    confirmDelete.value = null;
  }
}

function onSaved() {
  showCreateModal.value = false;
  editSchedule.value = null;
}

onMounted(() => {
  if (!scheduleStore.schedules.length) {
    scheduleStore.fetchSchedules();
  }
});
</script>
