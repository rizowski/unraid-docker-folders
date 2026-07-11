<template>
  <BaseModal :is-open="isOpen" max-width="560px" @close="$emit('close')">
    <div class="p-5 flex flex-col gap-4">
      <h2 class="text-lg font-semibold text-text m-0">{{ editId ? 'Edit Schedule' : 'New Schedule' }}</h2>

      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-text">Name</label>
        <input
          v-model="form.name"
          class="w-full px-3 py-2 rounded border border-border bg-bg text-text text-sm"
          placeholder="e.g. Nightly backup"
        />
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-sm font-medium text-text">Action</label>
        <select
          v-model="form.action"
          class="w-full px-3 py-2 rounded border border-border bg-bg text-text text-sm"
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
        <div class="flex flex-col gap-2 p-3 rounded border border-border bg-bg">
          <h3 class="text-sm font-semibold text-text m-0">Backup Configuration</h3>

          <template v-if="targetType === 'container'">
            <div class="flex flex-col gap-1">
              <label class="text-xs text-text-secondary">Paths to back up (container paths)</label>
              <div v-if="containerMounts.length" class="text-xs text-text-secondary mb-1">
                Available mounts: {{ containerMounts.map(m => m.Destination).join(', ') }}
              </div>
              <div v-for="(path, idx) in backupPaths" :key="idx" class="flex items-center gap-2">
                <input
                  :value="path"
                  class="flex-1 px-2 py-1.5 rounded border border-border bg-bg text-text text-sm font-mono"
                  placeholder="/config"
                  @input="backupPaths[idx] = ($event.target as HTMLInputElement).value"
                />
                <button class="text-error text-sm cursor-pointer bg-transparent border-none p-1" @click="backupPaths.splice(idx, 1)">x</button>
              </div>
              <button class="text-primary text-sm cursor-pointer bg-transparent border-none p-0 text-left w-fit" @click="backupPaths.push('')">+ Add path</button>
            </div>
          </template>

          <template v-else>
            <div v-for="(svc, idx) in backupServices" :key="idx" class="flex flex-col gap-1 p-2 rounded border border-border">
              <div class="flex items-center gap-2">
                <input
                  v-model="svc.service"
                  class="flex-1 px-2 py-1.5 rounded border border-border bg-bg text-text text-sm"
                  placeholder="Service name"
                />
                <button class="text-error text-sm cursor-pointer bg-transparent border-none p-1" @click="backupServices.splice(idx, 1)">x</button>
              </div>
              <div v-for="(p, pi) in svc.patterns" :key="pi" class="flex items-center gap-2 ml-4">
                <input
                  :value="p"
                  class="flex-1 px-2 py-1.5 rounded border border-border bg-bg text-text text-sm font-mono"
                  placeholder="/data"
                  @input="svc.patterns[pi] = ($event.target as HTMLInputElement).value"
                />
                <button class="text-error text-xs cursor-pointer bg-transparent border-none p-1" @click="svc.patterns.splice(pi, 1)">x</button>
              </div>
              <button class="text-primary text-xs cursor-pointer bg-transparent border-none p-0 text-left w-fit ml-4" @click="svc.patterns.push('')">+ Add path</button>
            </div>
            <button class="text-primary text-sm cursor-pointer bg-transparent border-none p-0 text-left w-fit" @click="backupServices.push({ service: '', patterns: [''] })">+ Add service</button>
          </template>

          <div class="flex gap-3">
            <div class="flex-1 flex flex-col gap-1">
              <label class="text-xs text-text-secondary">Destination (optional)</label>
              <input
                v-model="backupDestination"
                class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text text-sm font-mono"
                :placeholder="settingsStore.backupDestination"
              />
            </div>
            <div class="w-24 flex flex-col gap-1">
              <label class="text-xs text-text-secondary">Keep</label>
              <input
                v-model.number="backupRetention"
                type="number"
                min="1"
                class="w-full px-2 py-1.5 rounded border border-border bg-bg text-text text-sm"
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

      <div class="flex justify-end gap-2 pt-2">
        <button class="px-4 py-2 rounded border border-border bg-transparent text-text text-sm cursor-pointer hover:bg-bg" @click="$emit('close')">Cancel</button>
        <button class="px-4 py-2 rounded border-none bg-primary text-white text-sm cursor-pointer hover:opacity-90" :disabled="saving" @click="save">
          {{ saving ? 'Saving...' : (editId ? 'Update' : 'Create') }}
        </button>
      </div>
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
