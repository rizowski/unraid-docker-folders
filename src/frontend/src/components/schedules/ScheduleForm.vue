<template>
  <div class="flex flex-col gap-3" :class="embedded ? '' : 'p-3 rounded border border-border bg-bg'">
    <div v-if="!embedded" class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-semibold text-text m-0">{{ editId ? 'Edit Schedule' : 'New Schedule' }}</h3>
      <button class="icon-btn text-text-secondary hover:text-text" aria-label="Cancel" title="Cancel" @click="$emit('cancel')">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div class="flex flex-col gap-1">
      <label :for="`${uid}-name`" class="text-sm font-medium text-text">Name</label>
      <input :id="`${uid}-name`" v-model="form.name" class="form-input" placeholder="e.g. Nightly backup" />
    </div>

    <div class="flex flex-col gap-1">
      <label :for="`${uid}-action`" class="text-sm font-medium text-text">Action</label>
      <select :id="`${uid}-action`" v-model="form.action" class="form-input">
        <option value="start">Start</option>
        <option value="stop">Stop</option>
        <option value="pause">Pause</option>
        <option value="resume">Resume</option>
        <option value="restart">Restart</option>
        <option value="backup">Backup</option>
      </select>
    </div>

    <CronInput v-model="form.cron_expression" />

    <!-- Backup config -->
    <template v-if="form.action === 'backup'">
      <div class="flex flex-col gap-3 p-3 rounded border border-border bg-bg-card">
        <h4 class="text-sm font-semibold text-text m-0">Backup Configuration</h4>

        <template v-if="targetType === 'container'">
          <div class="flex flex-col gap-2">
            <label class="text-xs text-text-secondary">Paths to back up (container paths)</label>
            <div v-if="containerMounts.length" class="text-xs text-text-secondary">
              Available mounts: {{ containerMounts.map(m => m.Destination).join(', ') }}
            </div>
            <div v-for="(path, idx) in backupPaths" :key="idx" class="flex items-start gap-2">
              <PathSuggestInput
                class="flex-1 min-w-0"
                :model-value="path"
                scope="container"
                :container="targetId"
                :seed="mountPaths"
                placeholder="/config"
                @update:model-value="backupPaths[idx] = $event"
                @sqlite="onSqlite"
              />
              <button
                class="icon-btn shrink-0 text-text-secondary hover:text-error"
                aria-label="Remove path"
                title="Remove path"
                @click="backupPaths.splice(idx, 1)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div>
              <button class="nav-btn" @click="backupPaths.push('')">+ Add path</button>
            </div>
          </div>
        </template>

        <template v-else>
          <div v-for="(svc, idx) in backupServices" :key="idx" class="flex flex-col gap-2 p-3 rounded border border-border">
            <div class="flex items-center gap-2">
              <input v-model="svc.service" class="form-input compact" placeholder="Service name" />
              <button
                class="icon-btn shrink-0 text-text-secondary hover:text-error"
                aria-label="Remove service"
                title="Remove service"
                @click="backupServices.splice(idx, 1)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div v-for="(p, pi) in svc.patterns" :key="pi" class="flex items-start gap-2 ml-4">
              <!-- The frontend holds no mount data for a stack, so there is no
                   seed here. The endpoint reads the service's own mounts, and
                   it needs the project because a compose container is named
                   "<project>-<service>-1". -->
              <PathSuggestInput
                class="flex-1 min-w-0"
                :model-value="p"
                scope="container"
                :container="svc.service"
                :project="targetId"
                placeholder="/data"
                @update:model-value="svc.patterns[pi] = $event"
                @sqlite="onSqlite"
              />
              <button
                class="icon-btn shrink-0 text-text-secondary hover:text-error"
                aria-label="Remove path"
                title="Remove path"
                @click="svc.patterns.splice(pi, 1)"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <!-- margin lives on the wrapper: #…modern button.nav-btn sets margin:0,
                 which outranks a Tailwind ml-* utility -->
            <div class="ml-4">
              <button class="nav-btn" @click="svc.patterns.push('')">+ Add path</button>
            </div>
          </div>
          <div>
            <button class="nav-btn" @click="backupServices.push({ service: '', patterns: [''] })">+ Add service</button>
          </div>
        </template>

        <div class="flex flex-col gap-1">
          <label :for="`${uid}-quiesce`" class="text-xs text-text-secondary">While the backup runs</label>
          <select
            :id="`${uid}-quiesce`"
            v-model="backupQuiesce"
            class="form-input compact"
            @change="quiesceTouched = true"
          >
            <option v-for="mode in QUIESCE_MODES" :key="mode" :value="mode">{{ QUIESCE_LABELS[mode] }}</option>
          </select>
          <div class="text-xs text-text-secondary">{{ QUIESCE_HELP[backupQuiesce] }}</div>
          <div v-if="autoPaused" class="text-xs text-text-secondary">
            A database file sits in one of these folders, so this was set to Pause. Change it back if
            the container does not write to that database.
          </div>
          <div v-if="sqliteWarning" class="text-xs text-warning">
            A database file sits in one of these folders. Copying it while the container writes to it
            can produce a backup that does not restore.
          </div>
        </div>

        <div class="flex gap-3">
          <div class="flex-1 flex flex-col gap-1">
            <label :for="`${uid}-destination`" class="text-xs text-text-secondary">Destination (optional)</label>
            <PathSuggestInput
              v-model="backupDestination"
              scope="host"
              :input-id="`${uid}-destination`"
              :placeholder="settingsStore.backupDestination"
            />
          </div>
          <div class="w-24 flex flex-col gap-1">
            <label :for="`${uid}-retention`" class="text-xs text-text-secondary">Keep</label>
            <input
              :id="`${uid}-retention`"
              v-model.number="backupRetention"
              type="number"
              min="1"
              class="form-input compact"
              :placeholder="String(settingsStore.defaultRetentionCount)"
            />
          </div>
        </div>
      </div>
    </template>

    <div class="flex items-center gap-2">
      <input :id="`${uid}-enabled`" v-model="form.enabled" type="checkbox" class="cursor-pointer" />
      <label :for="`${uid}-enabled`" class="text-sm text-text cursor-pointer">Enabled</label>
    </div>

    <div v-if="formError" class="text-sm text-error">{{ formError }}</div>

    <div class="flex justify-end gap-2 pt-3 border-t border-border">
      <button class="nav-btn" @click="$emit('cancel')">Cancel</button>
      <button
        class="nav-btn active"
        :class="{ 'opacity-50 cursor-not-allowed': saving }"
        :disabled="saving"
        @click="save"
      >
        {{ saving ? 'Saving...' : (editId ? 'Update' : 'Create') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, useId } from 'vue';
import CronInput from './CronInput.vue';
import PathSuggestInput from '@/components/PathSuggestInput.vue';
import { useScheduleStore } from '@/stores/schedules';
import { useSettingsStore } from '@/stores/settings';
import { useDockerStore } from '@/stores/docker';
import type { ScheduleAction, BackupServiceConfig, TargetType, QuiesceMode } from '@/types/schedule';
import { SCHEDULE_ACTION_LABELS, QUIESCE_MODES, QUIESCE_LABELS, QUIESCE_HELP } from '@/types/schedule';
import type { ContainerMount } from '@/stores/docker';

interface Props {
  targetType: TargetType;
  targetId: string;
  editId?: number | null;
  /** Rendered inside a modal that already provides the title + close button. */
  embedded?: boolean;
}

const props = withDefaults(defineProps<Props>(), { editId: null, embedded: false });
const emit = defineEmits<{ cancel: []; saved: [] }>();

const scheduleStore = useScheduleStore();
const settingsStore = useSettingsStore();
const dockerStore = useDockerStore();

// The form is mounted fresh for each add/edit (callers key it on the edit id),
// so state is seeded once on mount rather than watched.
const uid = useId();
const saving = ref(false);
const formError = ref('');
const containerMounts = ref<ContainerMount[]>([]);

const form = reactive({
  name: '',
  action: 'backup' as ScheduleAction,
  cron_expression: '0 3 * * *',
  enabled: true,
});

const backupPaths = ref<string[]>(['']);
const backupServices = ref<{ service: string; patterns: string[] }[]>([{ service: '', patterns: [''] }]);
const backupDestination = ref('');
const backupRetention = ref<number | null>(null);

// Nothing is paused without a reason, so a new schedule starts on 'none'. It
// moves itself to 'pause' the first time a chosen folder turns out to hold a
// database, and says so. A saved schedule is never moved.
const backupQuiesce = ref<QuiesceMode>('none');
const quiesceTouched = ref(false);
const sqliteSeen = ref(false);

const mountPaths = computed(() => containerMounts.value.map(m => m.Destination));
const sqliteWarning = computed(() => sqliteSeen.value && backupQuiesce.value === 'none');

// The state onSqlite() left behind, not a second copy of it. Picking a mode by
// hand clears the line, because the mode is then the user's and not ours.
const autoPaused = computed(
  () => sqliteSeen.value && !quiesceTouched.value && backupQuiesce.value === 'pause',
);

function onSqlite(present: boolean) {
  if (!present) return;

  // Sticky: the listing that found the database is usually not the one on
  // screen when the user reads the message.
  sqliteSeen.value = true;

  // Only ever a suggestion, and only once. Choosing 'none' by hand with a
  // database present is a decision, not an oversight, so it is left alone and
  // the warning below carries the risk instead.
  if (quiesceTouched.value || backupQuiesce.value !== 'none') return;

  backupQuiesce.value = 'pause';
}

function seed() {
  if (!props.editId) return;

  const schedule = scheduleStore.schedules.find(s => s.id === props.editId);
  if (!schedule) return;

  form.name = schedule.name;
  form.action = schedule.action;
  form.cron_expression = schedule.cron_expression;
  form.enabled = schedule.enabled;

  if (!schedule.backup_config) return;

  const config = schedule.backup_config;
  backupDestination.value = config.destination || '';
  backupRetention.value = config.retention_count || null;
  backupQuiesce.value = config.quiesce || 'none';
  // A saved schedule already states what it wants, including 'none'.
  quiesceTouched.value = true;

  if (props.targetType === 'container' && Array.isArray(config.paths)) {
    backupPaths.value = (config.paths as string[]).length ? [...config.paths as string[]] : [''];
  } else if (props.targetType === 'stack' && Array.isArray(config.paths)) {
    backupServices.value = (config.paths as BackupServiceConfig[]).map(s => ({
      service: s.service,
      patterns: [...s.patterns],
    }));
  }
}

async function save() {
  formError.value = '';

  if (!form.name.trim()) {
    const actionLabel = SCHEDULE_ACTION_LABELS[form.action];
    form.name = `${actionLabel} ${props.targetId}`;
  }

  const data: Record<string, unknown> = {
    name: form.name,
    target_type: props.targetType,
    target_id: props.targetId,
    action: form.action,
    cron_expression: form.cron_expression,
    enabled: form.enabled,
  };

  if (form.action === 'backup') {
    const config: Record<string, unknown> = {};

    if (props.targetType === 'container') {
      const paths = backupPaths.value.filter(p => p.trim());
      if (!paths.length) {
        formError.value = 'At least one backup path is required';
        return;
      }
      config.paths = paths;
    } else {
      const services = backupServices.value
        .filter(s => s.service.trim() && s.patterns.some(p => p.trim()))
        .map(s => ({ service: s.service, patterns: s.patterns.filter(p => p.trim()) }));
      if (!services.length) {
        formError.value = 'At least one service with paths is required';
        return;
      }
      config.paths = services;
    }

    if (backupDestination.value.trim()) {
      config.destination = backupDestination.value.trim();
    }
    if (backupRetention.value && backupRetention.value > 0) {
      config.retention_count = backupRetention.value;
    }
    config.quiesce = backupQuiesce.value;

    data.backup_config = config;
  }

  saving.value = true;
  try {
    if (props.editId) {
      const ok = await scheduleStore.updateSchedule(props.editId, data);
      if (!ok) {
        formError.value = 'Failed to update schedule';
        return;
      }
    } else {
      const result = await scheduleStore.createSchedule(data);
      if (!result.success) {
        formError.value = result.error || 'Failed to create schedule';
        return;
      }
    }
    emit('saved');
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  seed();

  if (props.targetType === 'container') {
    const container = dockerStore.containers.find(c => c.name === props.targetId);
    containerMounts.value = container?.mounts || [];
  }

  if (!settingsStore.loaded) {
    settingsStore.fetchSettings();
  }
});
</script>
