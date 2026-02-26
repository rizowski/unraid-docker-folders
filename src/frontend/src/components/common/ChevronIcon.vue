<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0 text-text-secondary transition-transform duration-200"
    :class="expanded ? '' : '-rotate-90'"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
</template>

<script setup lang="ts">
interface Props {
  expanded?: boolean;
  size?: number;
}

withDefaults(defineProps<Props>(), {
  expanded: true,
  size: 14,
});
</script>
