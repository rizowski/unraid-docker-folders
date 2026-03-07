<template>
  <a v-if="href" :href="href" target="_blank" rel="noopener" class="inline-flex items-center gap-1 hover:underline" @click.stop>
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg><span class="sm:hidden">{{ shortImage }}</span><span class="hidden sm:inline">{{ image }}</span></a>
  <span v-else><span class="sm:hidden">{{ shortImage }}</span><span class="hidden sm:inline">{{ image }}</span></span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  image: string;
  href: string | null;
}>();

const shortImage = computed(() => {
  const img = props.image;
  // Strip registry prefix: "ghcr.io/user/name:tag" → "name:tag"
  const lastSlash = img.lastIndexOf('/');
  if (lastSlash >= 0) {
    return img.slice(lastSlash + 1);
  }
  return img;
});
</script>
