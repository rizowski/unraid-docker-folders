<template>
  <div class="flex flex-col gap-2">
    <label class="text-sm font-medium text-text">Schedule</label>
    <select
      :value="preset"
      class="w-full px-3 py-2 rounded border border-border bg-bg text-text text-sm"
      @change="onPresetChange(($event.target as HTMLSelectElement).value as CronPreset)"
    >
      <option v-for="(info, key) in CRON_PRESETS" :key="key" :value="key">{{ info.label }}</option>
    </select>

    <div v-if="preset === 'daily_custom'" class="flex items-center gap-2">
      <label class="text-xs text-text-secondary">Time:</label>
      <input
        type="time"
        :value="customTime"
        class="px-2 py-1.5 rounded border border-border bg-bg text-text text-sm"
        @change="onTimeChange(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div v-if="preset === 'weekly_custom'" class="flex items-center gap-2 flex-wrap">
      <label class="text-xs text-text-secondary">Day:</label>
      <select
        :value="customDay"
        class="px-2 py-1.5 rounded border border-border bg-bg text-text text-sm"
        @change="customDay = Number(($event.target as HTMLSelectElement).value); emitWeekly()"
      >
        <option v-for="(name, idx) in dayNames" :key="idx" :value="idx">{{ name }}</option>
      </select>
      <label class="text-xs text-text-secondary">Time:</label>
      <input
        type="time"
        :value="customTime"
        class="px-2 py-1.5 rounded border border-border bg-bg text-text text-sm"
        @change="onWeeklyTimeChange(($event.target as HTMLInputElement).value)"
      />
    </div>

    <div v-if="preset === 'custom'" class="flex flex-col gap-1">
      <input
        :value="modelValue"
        placeholder="* * * * *"
        class="w-full px-3 py-2 rounded border border-border bg-bg text-text text-sm font-mono"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <span class="text-xs text-text-secondary">Format: minute hour day-of-month month day-of-week</span>
    </div>

    <p class="text-xs text-text-secondary">{{ description }} (server timezone)</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { CRON_PRESETS, type CronPreset } from '@/types/schedule';

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

watch(() => props.modelValue, (val) => {
  if (val) detectPreset(val);
}, { immediate: true });

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

const description = computed(() => {
  const expr = props.modelValue;
  if (!expr) return '';
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return 'Invalid expression';

  const [min, hour, dom, mon, dow] = parts;

  if (expr === '* * * * *') return 'Runs every minute';
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Runs every hour';
  if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `Runs daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && /^\d+$/.test(dow) && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `Runs ${dayNames[Number(dow)]}s at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (min.includes('/')) return `Runs every ${min.split('/')[1]} minutes`;
  if (hour.includes('/')) return `Runs every ${hour.split('/')[1]} hours`;

  return `Cron: ${expr}`;
});
</script>
