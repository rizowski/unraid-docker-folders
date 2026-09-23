<template>
  <!--
    Shown only when the page asked for the GraphQL backend and the app could
    not use it. Reuses the warning banner pattern from ComposeSetupBanner.
  -->
  <div v-if="fallbackReason" class="flex items-center gap-3 px-4 py-3 mb-4 rounded bg-warning/10 border border-warning/30 text-sm">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-warning shrink-0">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
    <span class="text-text flex-1">
      The GraphQL backend is unavailable, so this page is using the PHP backend. {{ fallbackReason }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { fallbackReason } from '@/backends';
</script>
