<template>
  <span class="shrink-0 flex gap-1.5 text-xs font-mono">
    <span v-for="part in parts" :key="part.key" class="widget-stat flex flex-col w-10">
      <span class="text-right leading-tight" :class="loadClass(part.percent)">{{ part.percent === undefined ? '--' : formatPercent(part.percent) }}</span>
      <span class="h-0.5 stats-bar-track rounded-full overflow-hidden">
        <span
          v-if="part.percent !== undefined"
          class="block h-full rounded-full transition-all duration-300"
          :class="LOAD_BAR_CLASSES[loadLevel(part.percent)]"
          :style="{ width: Math.min(part.percent, 100) + '%' }"
        />
      </span>
    </span>
  </span>
</template>

<script setup lang="ts">
/**
 * The CPU and memory pair the widget shows on a container row and on the
 * all-running total. `undefined` is a value not loaded yet, shown as `--`.
 */
import { computed } from 'vue';
import { formatPercent, loadLevel, LOAD_BAR_CLASSES } from '@/utils/format';

const LOAD_TEXT_CLASSES = { high: 'text-error', medium: 'text-warning', low: 'text-text-secondary' } as const;

const props = defineProps<{
  cpu: number | undefined;
  memory: number | undefined;
}>();

// Computed rather than built in the template, so a rerender that does not
// touch the numbers does not rebuild the pair.
const parts = computed(() => [
  { key: 'cpu', percent: props.cpu },
  { key: 'memory', percent: props.memory },
]);

function loadClass(percent: number | undefined): string {
  return percent === undefined ? 'text-text-secondary' : LOAD_TEXT_CLASSES[loadLevel(percent)];
}
</script>
