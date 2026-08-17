<!--
  Material's `folder`, redrawn as a 2px stroke to match the rest of the toolbar.
  Material's `create_new_folder` carries its own plus, which would double the
  leading "+" on the button, so this is the plain folder. See DESIGN.md §5.
-->
<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 16 });
</script>
