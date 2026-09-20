<template>
  <BaseModal :is-open="isOpen" max-width="760px" @close="$emit('close')">
    <div class="flex justify-between items-center gap-3 p-4 sm:p-6 border-b border-border">
      <h2 class="text-xl font-semibold text-text m-0 truncate">Schedules: {{ targetId }}</h2>
      <div class="flex items-center gap-2 shrink-0">
        <button v-if="!formOpen" class="nav-btn active" @click="openCreate">+ Add Schedule</button>
        <button
          class="icon-btn icon-btn-round text-text-secondary hover:text-text"
          aria-label="Close"
          @click="$emit('close')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>

    <div class="p-4 sm:p-6 flex flex-col gap-3">
      <!-- Nothing else tells the user that schedules have stopped running. The
           runner is a cron entry outside this app, so a missing or dead entry
           looks exactly like a quiet day. The server puts a missing entry back
           on its own, so this row reports rather than asks. -->
      <div
        v-if="scheduleStore.runnerStalled"
        class="flex items-center gap-3 p-3 rounded border border-border bg-bg"
      >
        <svg class="text-warning shrink-0" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
        <div class="flex-1 min-w-0 text-xs text-text-secondary">
          <div class="text-sm text-text">{{ runnerTitle }}</div>
          <div class="mt-0.5">{{ runnerMessage }}</div>
        </div>
      </div>

      <!-- The add/edit form renders inline above the list rather than opening a
           second modal over this one. -->
      <ScheduleForm
        v-if="formOpen"
        :key="editSchedule ?? 'new'"
        :target-type="targetType"
        :target-id="targetId"
        :edit-id="editSchedule"
        @cancel="closeForm"
        @saved="closeForm"
      />

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
              <span class="text-xs px-1.5 py-0.5 rounded bg-bg-card text-text-secondary shrink-0">{{ SCHEDULE_ACTION_LABELS[schedule.action] }}</span>
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
              class="icon-btn text-text-secondary hover:text-primary"
              aria-label="Run now"
              title="Run now"
              @click="confirmRun = schedule.id"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 4l14 8-14 8z" /></svg>
            </button>
            <button
              class="icon-btn text-text-secondary hover:text-text"
              aria-label="History"
              title="History"
              @click="showHistory = schedule.id"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>
            </button>
            <button
              class="icon-btn text-text-secondary hover:text-text"
              :class="{ 'text-primary': editSchedule === schedule.id }"
              aria-label="Edit"
              title="Edit"
              @click="openEdit(schedule.id)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            </button>
            <button
              class="icon-btn text-text-secondary hover:text-error"
              aria-label="Delete"
              title="Delete"
              @click="confirmDelete = schedule.id"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </button>
          </div>
        </div>
      </div>

    </div>

    <!-- These teleport their own overlay to the app root, so they render as
         siblings of this one rather than inside its scroll container. -->
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

    <!-- Run now sits one icon away from History and Edit and acts at once, so
         a mis-click used to stop or restart a container with no warning. -->
    <ConfirmModal
      :is-open="confirmRun !== null"
      title="Run Schedule Now"
      :message="runConfirmMessage"
      confirm-label="Run now"
      @confirm="doRun"
      @cancel="confirmRun = null"
    />
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import ScheduleForm from './ScheduleForm.vue';
import ScheduleHistoryModal from './ScheduleHistoryModal.vue';
import { useScheduleStore } from '@/stores/schedules';
import { useSettingsStore } from '@/stores/settings';
import { scheduleStatusClass } from '@/utils/format';
import type { TargetType } from '@/types/schedule';
import { SCHEDULE_ACTION_LABELS } from '@/types/schedule';

interface Props {
  isOpen: boolean;
  targetType: TargetType;
  targetId: string;
}

const props = defineProps<Props>();
defineEmits<{ close: [] }>();

const scheduleStore = useScheduleStore();
const settingsStore = useSettingsStore();
const loading = computed(() => scheduleStore.loading);

const formOpen = ref(false);
const editSchedule = ref<number | null>(null);
const showHistory = ref<number | null>(null);
const confirmDelete = ref<number | null>(null);
const confirmRun = ref<number | null>(null);

// One minute for the next cron boundary, plus a little room.
const RECHECK_DELAY_MS = 70000;
let recheck: ReturnType<typeof setTimeout> | null = null;

function clearRecheck() {
  if (recheck !== null) {
    clearTimeout(recheck);
    recheck = null;
  }
}

const runConfirmMessage = computed(() => {
  const schedule = scheduleStore.schedules.find((s) => s.id === confirmRun.value);
  if (!schedule) return 'Run this schedule now?';
  const action = SCHEDULE_ACTION_LABELS[schedule.action].toLowerCase();
  return `Run "${schedule.name}" now? This will ${action} ${schedule.target_type} ${schedule.target_id} immediately.`;
});

const runnerTitle = computed(() =>
  scheduleStore.runner?.repaired ? 'Schedule runner reinstalled' : 'Scheduled actions are not running',
);

const runnerMessage = computed(() => {
  const state = scheduleStore.runner;
  if (!state) return '';
  if (state.repaired) {
    return 'The cron entry was missing and has been put back. Its first run takes up to a minute.';
  }
  if (!state.cron_installed) {
    return 'The cron entry that runs schedules is missing, and it could not be reinstalled.';
  }
  if (state.last_tick === null) {
    return 'The schedule runner has not run since the server started.';
  }
  return `The schedule runner last ran at ${formatTime(state.last_tick)}.`;
});

const targetSchedules = computed(() =>
  scheduleStore.schedulesForTarget(props.targetType, props.targetId),
);

const formatTime = settingsStore.formatServerTime;
const statusClass = scheduleStatusClass;

// This modal stays mounted between openings, so drop any open form on close.
// Opening refetches: the runner state carries a server-side staleness flag
// taken when the response was built, and a snapshot from an hour ago would
// claim the runner had stopped.
watch(() => props.isOpen, (open) => {
  if (open) {
    scheduleStore.fetchSchedules(true);
    return;
  }
  closeForm();
});

function openCreate() {
  editSchedule.value = null;
  formOpen.value = true;
}

function openEdit(id: number) {
  // Toggle off when the same row's form is already showing.
  if (formOpen.value && editSchedule.value === id) {
    closeForm();
    return;
  }
  editSchedule.value = id;
  formOpen.value = true;
}

function closeForm() {
  formOpen.value = false;
  editSchedule.value = null;
}

async function doRun() {
  const id = confirmRun.value;
  confirmRun.value = null;
  if (id !== null) {
    await scheduleStore.runScheduleNow(id);
  }
}

// A repair is only visible in the response that performed it. The heartbeat
// lands on the next minute boundary, so look once more after that instead of
// leaving the row claiming a fault the server has already fixed.
watch(() => scheduleStore.runner?.repaired, (repaired) => {
  if (!repaired) return;
  clearRecheck();
  recheck = setTimeout(() => {
    recheck = null;
    scheduleStore.fetchSchedules(true);
  }, RECHECK_DELAY_MS);
}, { immediate: true });

async function doDelete() {
  if (confirmDelete.value !== null) {
    await scheduleStore.deleteSchedule(confirmDelete.value);
    confirmDelete.value = null;
  }
}

onMounted(() => {
  if (!scheduleStore.schedules.length) {
    scheduleStore.fetchSchedules();
  }
});

onBeforeUnmount(clearRecheck);
</script>
