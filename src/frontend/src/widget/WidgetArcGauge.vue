<template>
  <div class="widget-arc flex flex-col items-center min-w-0" :title="title">
    <svg viewBox="0 0 100 58" class="w-full max-w-32" role="img" :aria-label="`${label} ${valueText}`">
      <path :d="ARC" pathLength="100" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" class="text-border" />
      <path
        v-if="percent !== undefined && percent > 0"
        :d="ARC"
        pathLength="100"
        fill="none"
        stroke="currentColor"
        stroke-width="9"
        stroke-linecap="round"
        class="arc-fill"
        :class="FILL_CLASSES[loadLevel(percent)]"
        :stroke-dasharray="`${Math.min(percent, 100)} 100`"
      />
      <text x="50" y="50" text-anchor="middle" class="fill-text font-mono text-[15px] font-semibold">{{ valueText }}</text>
    </svg>
    <span class="text-xs font-semibold leading-tight">{{ label }}</span>
    <span class="text-[11px] text-text-secondary leading-tight truncate max-w-full">{{ detail }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * A half-circle gauge for the widget's all-running total. The arc fills to
 * the percent, colored by load the same way as the row bars. `undefined` is
 * a value not loaded yet, shown as `--` over an empty arc.
 */
import { computed } from 'vue';
import { formatPercent, loadLevel } from '@/utils/format';

/** The top half of a circle of radius 40, left to right, inside a 100-wide box. */
const ARC = 'M 10 50 A 40 40 0 0 1 90 50';
const FILL_CLASSES = { high: 'text-error', medium: 'text-warning', low: 'text-success' } as const;

const props = defineProps<{
  label: string;
  percent: number | undefined;
  /** Second line under the label, such as the core count or bytes used. */
  detail: string;
  title?: string;
}>();

const valueText = computed(() => (props.percent === undefined ? '--' : formatPercent(props.percent)));
</script>

<style scoped>
.arc-fill {
  transition: stroke-dasharray 300ms ease;
}
</style>
