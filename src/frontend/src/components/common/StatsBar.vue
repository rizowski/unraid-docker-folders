<template>
  <!-- Loading skeleton -->
  <template v-if="percent === null">
    <div v-if="size === 'wide'" class="space-y-0.5">
      <div class="flex justify-between text-xs">
        <span class="text-muted">{{ label }}</span>
        <span class="text-text font-mono">--</span>
      </div>
      <div class="w-full h-1.5 stats-bar-track rounded-full overflow-hidden">
        <div class="h-full w-1/3 rounded-full bg-border animate-pulse"></div>
      </div>
    </div>
    <div v-else-if="size === 'inline'" class="flex items-center gap-1.5 text-[11px]">
      <span class="text-text w-7 text-right">{{ label }}</span>
      <div class="flex-1 h-1 stats-bar-track rounded-full overflow-hidden">
        <div class="h-full w-1/4 rounded-full bg-border animate-pulse"></div>
      </div>
      <span class="text-text font-mono w-9 text-right">--</span>
    </div>
    <div v-else class="flex items-center gap-2 text-xs">
      <span class="text-text w-8 shrink-0">{{ label }}</span>
      <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
        <div class="h-full w-1/3 rounded-full bg-border animate-pulse"></div>
      </div>
      <span class="text-text font-mono w-12 text-right shrink-0">--</span>
    </div>
  </template>

  <!-- Filled bar -->
  <template v-else>
    <div v-if="size === 'wide'" class="space-y-0.5">
      <div class="flex justify-between text-xs">
        <span class="text-muted">{{ label }}</span>
        <span class="text-text-secondary font-mono">{{ formattedValue ?? formatPercent(percent) }}</span>
      </div>
      <div class="w-full h-1.5 stats-bar-track rounded-full overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-300"
          :class="barColor"
          :style="{ width: Math.min(percent, 100) + '%' }"
        ></div>
      </div>
    </div>
    <div v-else-if="size === 'inline'" class="flex items-center gap-1.5 text-[11px]">
      <span class="text-text w-7 text-right">{{ label }}</span>
      <div class="flex-1 h-1 stats-bar-track rounded-full overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-300"
          :class="barColor"
          :style="{ width: Math.min(percent, 100) + '%' }"
        ></div>
      </div>
      <span class="text-text font-mono w-9 text-right">{{ formattedValue ?? formatPercent(percent) }}</span>
    </div>
    <div v-else class="flex items-center gap-2 text-xs">
      <span class="text-text w-8 shrink-0">{{ label }}</span>
      <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-300"
          :class="barColor"
          :style="{ width: Math.min(percent, 100) + '%' }"
        ></div>
      </div>
      <span class="text-text font-mono w-12 text-right shrink-0">{{ formattedValue ?? formatPercent(percent) }}</span>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatPercent } from '@/utils/format';

interface Props {
  label: string;
  percent: number | null;
  formattedValue?: string;
  size?: 'compact' | 'inline' | 'wide';
}

const props = withDefaults(defineProps<Props>(), {
  size: 'compact',
});

const barColor = computed(() => {
  const pct = props.percent ?? 0;
  if (pct > 80) return 'bg-error';
  if (pct > 50) return 'bg-warning';
  return 'bg-success';
});
</script>
