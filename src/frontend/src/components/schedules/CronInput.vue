<template>
  <div class="flex flex-col gap-2">
    <label :for="`${uid}-cron-preset`" class="text-sm font-medium text-text">Schedule</label>
    <select
      :id="`${uid}-cron-preset`"
      :value="preset"
      class="form-input"
      @change="onPresetChange(($event.target as HTMLSelectElement).value as CronPreset)"
    >
      <option v-for="(info, key) in CRON_PRESETS" :key="key" :value="key">{{ info.label }}</option>
    </select>

    <div v-if="preset === 'daily_custom'" class="flex items-center gap-2">
      <label :for="`${uid}-cron-daily-time`" class="text-xs text-text-secondary">Time:</label>
      <input
        :id="`${uid}-cron-daily-time`"
        type="time"
        :value="customTime"
        class="form-input compact auto-width"
        @change="onTimeChange(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div v-if="preset === 'weekly_custom'" class="flex items-center gap-2 flex-wrap">
      <label :for="`${uid}-cron-weekly-day`" class="text-xs text-text-secondary">Day:</label>
      <select
        :id="`${uid}-cron-weekly-day`"
        :value="customDay"
        class="form-input compact auto-width"
        @change="customDay = Number(($event.target as HTMLSelectElement).value); emitWeekly()"
      >
        <option v-for="(name, idx) in dayNames" :key="idx" :value="idx">{{ name }}</option>
      </select>
      <label :for="`${uid}-cron-weekly-time`" class="text-xs text-text-secondary">Time:</label>
      <input
        :id="`${uid}-cron-weekly-time`"
        type="time"
        :value="customTime"
        class="form-input compact auto-width"
        @change="onWeeklyTimeChange(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div v-if="preset === 'custom'" class="flex flex-col gap-1">
      <input
        :value="modelValue"
        placeholder="* * * * *"
        class="form-input mono"
        @input="onCustomInput(($event.target as HTMLInputElement).value)"
      />
      <span class="text-xs text-text-secondary">Format: minute hour day-of-month month day-of-week</span>
    </div>

    <p class="text-xs text-text-secondary">{{ description }} ({{ settingsStore.serverTimezone ?? 'server timezone' }})</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, useId } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { CRON_PRESETS, type CronPreset } from '@/types/schedule';
import { describeCron, DAY_NAMES } from '@/utils/cron';

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const settingsStore = useSettingsStore();

// Unique per instance: the panel modal and the inline list form can both be
// mounted, and duplicate ids would bind <label for> to the wrong field.
const uid = useId();

const dayNames = DAY_NAMES;

const preset = ref<CronPreset>('daily_3am');
const customTime = ref('03:00');
const customDay = ref(1);

function detectPreset(expr: string) {
  for (const [key, info] of Object.entries(CRON_PRESETS)) {
    if (info.expression === expr) {
      preset.value = key as CronPreset;
      return;
    }
  }

  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    preset.value = 'custom';
    return;
  }

  const [min, hour, dom, mon, dow] = parts;
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    preset.value = 'daily_custom';
    customTime.value = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    return;
  }

  if (dom === '*' && mon === '*' && /^\d+$/.test(dow) && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    preset.value = 'weekly_custom';
    customDay.value = Number(dow);
    customTime.value = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    return;
  }

  preset.value = 'custom';
}

// The last value typed into the custom field. Re-detecting the preset on those
// keystrokes would switch away from 'custom' mid-edit: typing "45 6 * * 1-5"
// passes through "45 6 * * 1", which matches weekly_custom and unmounts the input.
let lastCustomValue: string | null = null;

watch(() => props.modelValue, (val) => {
  if (preset.value === 'custom' && val === lastCustomValue) return;
  if (val) detectPreset(val);
}, { immediate: true });

function onCustomInput(value: string) {
  lastCustomValue = value;
  emit('update:modelValue', value);
}

function onPresetChange(p: CronPreset) {
  preset.value = p;
  const info = CRON_PRESETS[p];
  if (info.expression) {
    emit('update:modelValue', info.expression);
  } else if (p === 'daily_custom') {
    emitDaily();
  } else if (p === 'weekly_custom') {
    emitWeekly();
  }
}

function onTimeChange(time: string) {
  customTime.value = time;
  emitDaily();
}

function onWeeklyTimeChange(time: string) {
  customTime.value = time;
  emitWeekly();
}

function emitDaily() {
  const [h, m] = customTime.value.split(':').map(Number);
  emit('update:modelValue', `${m} ${h} * * *`);
}

function emitWeekly() {
  const [h, m] = customTime.value.split(':').map(Number);
  emit('update:modelValue', `${m} ${h} * * ${customDay.value}`);
}

const description = computed(() => (props.modelValue ? describeCron(props.modelValue) : ''));
</script>
