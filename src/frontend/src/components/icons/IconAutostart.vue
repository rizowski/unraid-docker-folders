<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <!-- Circular arrow: arc from top-right going clockwise, gap at top-right for arrowhead -->
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <!-- Arrowhead pointing right/down at the top-right of the circle -->
    <polyline points="21 3 21 9 15 9" />
    <!-- Letter A -->
    <path d="M9 17l3-10 3 10" />
    <line x1="10" y1="14" x2="14" y2="14" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 16 });
</script>
