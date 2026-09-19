<template>
  <a
    v-if="item.href"
    :href="item.href"
    :target="item.target"
    rel="noopener"
    class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition cursor-pointer no-underline"
    :class="item.class || 'text-text'"
    @click="emit('select', item)"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path v-for="(d, i) in (item.icon ?? '').split('|')" :key="i" :d="d" />
    </svg>
    {{ item.label }}
  </a>
  <button
    v-else
    :disabled="item.disabled"
    :title="item.title"
    class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition text-left border-none bg-transparent disabled:opacity-40 disabled:cursor-not-allowed"
    :class="[item.class || 'text-text', item.disabled ? '' : 'cursor-pointer']"
    @click="emit('select', item)"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path v-for="(d, i) in (item.icon ?? '').split('|')" :key="i" :d="d" />
    </svg>
    {{ item.label }}
    <!-- A disabled item that says why gets an info mark, so people know the
         button's tooltip is there. -->
    <svg v-if="item.disabled && item.title" class="kebab-info-icon ml-auto shrink-0 text-text-secondary" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
    </svg>
  </button>
</template>

<script setup lang="ts">
import type { KebabMenuItem } from './KebabMenu.vue';

defineProps<{ item: KebabMenuItem }>();

const emit = defineEmits<{ select: [item: KebabMenuItem] }>();
</script>
