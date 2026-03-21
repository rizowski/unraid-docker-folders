<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <polygon points="6,3 20,12 6,21" />
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>
