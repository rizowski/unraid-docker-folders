<template>
  <div ref="menuRef" class="relative">
    <button
      :class="buttonClass"
      :title="buttonTitle"
      @click.stop="menuOpen = !menuOpen"
    >
      <svg xmlns="http://www.w3.org/2000/svg" :width="iconSize" :height="iconSize" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
      </svg>
    </button>
    <div
      v-if="menuOpen"
      class="absolute right-0 bg-bg border border-border rounded-lg shadow-lg py-1.5 min-w-[160px] z-[100]"
      :class="position === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'"
    >
      <template v-for="item in visibleItems" :key="item.label">
        <a
          v-if="item.href"
          :href="item.href"
          :target="item.target"
          rel="noopener"
          class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition cursor-pointer no-underline"
          :class="item.class || 'text-text'"
          @click="menuOpen = false"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="(d, i) in item.icon.split('|')" :key="i" :d="d" />
          </svg>
          {{ item.label }}
        </a>
        <button
          v-else
          class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition cursor-pointer text-left border-none bg-transparent"
          :class="item.class || 'text-text'"
          @click="menuOpen = false; $emit('select', item.action!)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="(d, i) in item.icon.split('|')" :key="i" :d="d" />
          </svg>
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

export interface KebabMenuItem {
  label: string;
  icon: string;
  show?: boolean;
  href?: string;
  target?: string;
  action?: string;
  class?: string;
}

interface Props {
  items: KebabMenuItem[];
  position?: 'below' | 'above';
  buttonTitle?: string;
  buttonClass?: string;
  iconSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  position: 'below',
  buttonTitle: 'More actions',
  buttonClass: 'p-1.5 rounded cursor-pointer text-text-secondary hover:text-text transition',
  iconSize: 16,
});

defineEmits<{
  select: [action: string];
}>();

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

const visibleItems = computed(() => props.items.filter((item) => item.show !== false));

function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', onClickOutside, true));
onUnmounted(() => document.removeEventListener('click', onClickOutside, true));

defineExpose({ menuOpen });
</script>
