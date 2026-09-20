<template>
  <!-- The note a row carries, folded into the row rather than printed under
       it. The same explanation as a paragraph pushed the table apart and made
       a two-line finding read as six. `title` is the whole text, so nothing is
       lost, and the icon inherits the cell's color rather than carrying one of
       its own: DESIGN.md §1 keeps the status colors for state. -->
  <span
    class="inline-flex align-text-bottom ml-1 text-text-secondary hover:text-primary cursor-help"
    :title="text"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  </span>
</template>

<script setup lang="ts">
defineProps<{ text: string }>();
</script>
