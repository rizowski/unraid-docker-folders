<!--
  Toolbar control for the global sort mode (container order, and folder order
  when "Sort folders too" is on). Chrome mirrors CreateMenu.vue so the two toolbar
  dropdowns read as one pattern; see DESIGN.md §11 — every item carries
  `.kebab-menu-item` or the Unraid reset strips its padding.
-->
<template>
  <div ref="menuRef" class="relative shrink-0">
    <button
      class="nav-btn"
      :title="`Sort: ${activeOption.label}`"
      :aria-label="`Sort: ${activeOption.label}`"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click.stop="menuOpen = !menuOpen"
    >
      <!-- The trigger shows the active mode's icon, so the current sort reads at a glance. -->
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-for="(d, i) in activeOption.icon.split('|')" :key="i" :d="d" />
      </svg>
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
        class="shrink-0 transition-transform duration-200"
        :class="{ 'rotate-180': menuOpen }"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    <!-- left-0, not CreateMenu's right-0: this button sits on the left of the
         header, so a right-anchored panel would run off the frame. -->
    <div
      v-if="menuOpen"
      role="menu"
      class="absolute left-0 top-full mt-1 bg-bg border border-border rounded-lg shadow-lg py-1.5 min-w-[180px] z-[100]"
    >
      <button
        v-for="opt in SORT_MODE_OPTIONS"
        :key="opt.value"
        role="menuitemradio"
        :aria-checked="opt.value === modelValue"
        class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition text-left border-none bg-transparent cursor-pointer whitespace-nowrap"
        :class="opt.value === modelValue ? 'text-primary font-semibold' : 'text-text'"
        @click="select(opt.value)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path v-for="(d, i) in opt.icon.split('|')" :key="i" :d="d" />
        </svg>
        <span class="flex-1">{{ opt.label }}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0"
          :class="{ invisible: opt.value !== modelValue }"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>
      <hr class="my-1 border-0 border-t border-border" />
      <!-- Stays open on toggle, so the user sees the check change. -->
      <button
        role="menuitemcheckbox"
        :aria-checked="sortFolders"
        class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition text-left border-none bg-transparent cursor-pointer whitespace-nowrap text-text"
        @click.stop="emit('update:sortFolders', !sortFolders)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span class="flex-1">Sort folders too</span>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0" :class="{ invisible: !sortFolders }" aria-hidden="true">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { SORT_MODE_OPTIONS, type SortMode } from '@/types/folder';

const props = withDefaults(
  defineProps<{
    modelValue: SortMode;
    /** Whether an automatic mode also reorders folders. */
    sortFolders?: boolean;
  }>(),
  { sortFolders: false }
);

const activeOption = computed(() => SORT_MODE_OPTIONS.find((o) => o.value === props.modelValue) ?? SORT_MODE_OPTIONS[0]);

const emit = defineEmits<{
  'update:modelValue': [value: SortMode];
  'update:sortFolders': [value: boolean];
}>();

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function select(value: SortMode) {
  menuOpen.value = false;
  emit('update:modelValue', value);
}

function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') menuOpen.value = false;
}

onMounted(() => {
  document.addEventListener('click', onClickOutside, true);
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('click', onClickOutside, true);
  document.removeEventListener('keydown', onKeydown);
});
</script>
