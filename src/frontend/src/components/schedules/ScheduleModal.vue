<template>
  <BaseModal :is-open="isOpen" max-width="560px" @close="$emit('close')">
    <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border">
      <h2 class="text-xl font-semibold text-text m-0">{{ editId ? 'Edit Schedule' : 'New Schedule' }}</h2>
      <button
        class="flex items-center justify-center w-8 h-8 rounded-full bg-transparent cursor-pointer text-text-secondary hover:text-text hover:bg-border transition"
        aria-label="Close"
        @click="$emit('close')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div class="p-4 sm:p-6 flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <label for="schedule-name" class="font-medium text-text">Name</label>
        <input
          id="schedule-name"
          v-model="form.name"
          class="w-full py-2 px-4 border border-input-border rounded bg-input-bg text-text focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
          placeholder="e.g. Nightly backup"
        />
      </div>

      <div class="flex flex-col gap-1">
        <label for="schedule-action" class="font-medium text-text">Action</label>
        <select
          id="schedule-action"
          v-model="form.action"
          class="w-full py-2 px-4 border border-input-border rounded bg-input-bg text-text cursor-pointer focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
        >
          <option value="start">Start</option>
          <option value="stop">Stop</option>
          <option value="pause">Pause</option>
          <option value="restart">Restart</option>
          <option value="backup">Backup</option>
        </select>
      </div>

      <CronInput v-model="form.cron_expression" />

      <!-- Backup config -->
      <template v-if="form.action === 'backup'">
        <div class="flex flex-col gap-3 p-4 rounded border border-border bg-bg-card">
          <h3 class="text-sm font-semibold text-text m-0">Backup Configuration</h3>

          <template v-if="targetType === 'container'">
            <div class="flex flex-col gap-2">
              <label class="text-xs text-text-secondary">Paths to back up (container paths)</label>
              <div v-if="containerMounts.length" class="text-xs text-text-secondary">
                Available mounts: {{ containerMounts.map(m => m.Destination).join(', ') }}
              </div>
              <div v-for="(path, idx) in backupPaths" :key="idx" class="flex items-center gap-2">
                <input
                  :value="path"
                  class="flex-1 py-1.5 px-3 border border-input-border rounded bg-input-bg text-text text-sm font-mono focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  placeholder="/config"
                  @input="backupPaths[idx] = ($event.target as HTMLInputElement).value"
                />
                <button
                  class="flex items-center justify-center p-1.5 shrink-0 rounded cursor-pointer text-text-secondary hover:text-error transition"
                  aria-label="Remove path"
                  @click="backupPaths.splice(idx, 1)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
              <button class="nav-btn w-fit" @click="backupPaths.push('')">+ Add path</button>
            </div>
          </template>

          <template v-else>
            <div v-for="(svc, idx) in backupServices" :key="idx" class="flex flex-col gap-2 p-3 rounded border border-border">
              <div class="flex items-center gap-2">
                <input
                  v-model="svc.service"
                  class="flex-1 py-1.5 px-3 border border-input-border rounded bg-input-bg text-text text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  placeholder="Service name"
                />
                <button
                  class="flex items-center justify-center p-1.5 shrink-0 rounded cursor-pointer text-text-secondary hover:text-error transition"
                  aria-label="Remove service"
                  @click="backupServices.splice(idx, 1)"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              </div>
              <div v-for="(p, pi) in svc.patterns" :key="pi" class="flex items-center gap-2 ml-4">
                <input
                  :value="p"
                  class="flex-1 py-1.5 px-3 border border-input-border rounded bg-input-bg text-text text-sm font-mono focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                  placeholder="/data"
                  @input="svc.patterns[pi] = ($event.target as HTMLInputElement).value"
                />
                <button
                  class="flex items-center justify-center p-1.5 shrink-0 rounded cursor-pointer text-text-secondary hover:text-error transition"
                  aria-label="Remove path"
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
            <button class="nav-btn w-fit" @click="backupServices.push({ service: '', patterns: [''] })">+ Add service</button>
          </template>

          <div class="flex gap-3">
            <div class="flex-1 flex flex-col gap-1">
              <label for="backup-destination" class="text-xs text-text-secondary">Destination (optional)</label>
              <input
                id="backup-destination"
                v-model="backupDestination"
                class="w-full py-1.5 px-3 border border-input-border rounded bg-input-bg text-text text-sm font-mono focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                :placeholder="settingsStore.backupDestination"
              />
            </div>
            <div class="w-24 flex flex-col gap-1">
              <label for="backup-retention" class="text-xs text-text-secondary">Keep</label>
              <input
                id="backup-retention"
                v-model.number="backupRetention"
                type="number"
                min="1"
                class="w-full py-1.5 px-3 border border-input-border rounded bg-input-bg text-text text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                :placeholder="String(settingsStore.defaultRetentionCount)"
              />
            </div>
          </div>
        </div>
      </template>

      <div class="flex items-center gap-2">
        <input id="schedule-enabled" v-model="form.enabled" type="checkbox" class="cursor-pointer" />
        <label for="schedule-enabled" class="text-sm text-text cursor-pointer">Enabled</label>
      </div>

      <div v-if="formError" class="text-sm text-error">{{ formError }}</div>
    </div>

    <div class="flex justify-end gap-2 p-4 sm:p-6 pt-4 border-t border-border">
      <button class="nav-btn" @click="$emit('close')">Cancel</button>
      <button
        class="nav-btn active"
        :class="{ 'opacity-50 cursor-not-allowed': saving }"
        :disabled="saving"
        @click="save"
      >
        {{ saving ? 'Saving...' : (editId ? 'Update' : 'Create') }}
      </button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import CronInput from './CronInput.vue';
import { useScheduleStore } from '@/stores/schedules';
import { useSettingsStore } from '@/stores/settings';
import { useDockerStore } from '@/stores/docker';
import type { ScheduleAction, BackupServiceConfig } from '@/types/schedule';
import type { ContainerMount } from '@/stores/docker';

interface Props {
  isOpen: boolean;
  targetType: 'container' | 'stack';
  targetId: string;
  editId?: number | null;
}

const props = withDefaults(defineProps<Props>(), { editId: null });
const emit = defineEmits<{ close: []; saved: [] }>();

const scheduleStore = useScheduleStore();
const settingsStore = useSettingsStore();
const dockerStore = useDockerStore();

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

watch(() => props.isOpen, async (open) => {
  if (!open) return;
  formError.value = '';

  if (props.editId) {
    const schedule = scheduleStore.schedules.find(s => s.id === props.editId);
    if (schedule) {
      form.name = schedule.name;
      form.action = schedule.action;
      form.cron_expression = schedule.cron_expression;
      form.enabled = schedule.enabled;

      if (schedule.backup_config) {
        const config = schedule.backup_config;
        backupDestination.value = config.destination || '';
        backupRetention.value = config.retention_count || null;

        if (props.targetType === 'container' && Array.isArray(config.paths)) {
          backupPaths.value = (config.paths as string[]).length ? [...config.paths as string[]] : [''];
        } else if (props.targetType === 'stack' && Array.isArray(config.paths)) {
          backupServices.value = (config.paths as BackupServiceConfig[]).map(s => ({
            service: s.service,
            patterns: [...s.patterns],
          }));
        }
      }
    }
  } else {
    form.name = '';
    form.action = 'backup';
    form.cron_expression = '0 3 * * *';
    form.enabled = true;
    backupPaths.value = [''];
    backupServices.value = [{ service: '', patterns: [''] }];
    backupDestination.value = '';
    backupRetention.value = null;
  }

  if (props.targetType === 'container') {
    const container = dockerStore.containers.find(c => c.name === props.targetId);
    containerMounts.value = container?.mounts || [];
  }
});

async function save() {
  formError.value = '';

  if (!form.name.trim()) {
    const actionLabel = form.action.charAt(0).toUpperCase() + form.action.slice(1);
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
    emit('close');
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  if (!settingsStore.loaded) {
    settingsStore.fetchSettings();
  }
});
</script>
