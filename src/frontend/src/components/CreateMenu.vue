<!--
  The toolbar's single "create" affordance. Replaces three side-by-side
  `+ icon` buttons that cost three toolbar slots and still needed a tooltip to
  say what each one made.

  Chrome is copied verbatim from KebabMenu.vue rather than reusing it: that
  component takes icons as pipe-delimited `<path d>` strings, and IconStack /
  IconContainer are polygons and polylines, not paths. See DESIGN.md §11 — every
  item carries `.kebab-menu-item` or the Unraid reset strips its padding.
-->
<template>
  <div ref="menuRef" class="relative">
    <button
      class="nav-btn active"
      title="Create"
      aria-label="Create"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click.stop="menuOpen = !menuOpen"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      <!-- Inlined rather than using common/ChevronIcon: that one hardcodes
           `text-text-secondary`, which fights `.nav-btn.active`'s
           `--header-text-color`, and rotates to point right when collapsed
           instead of flipping up when open. -->
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
    <div
      v-if="menuOpen"
      role="menu"
      class="absolute right-0 top-full mt-1 bg-bg border border-border rounded-lg shadow-lg py-1.5 min-w-[160px] z-[100]"
    >
      <!-- Stays an <a> with a plain relative href: that is what escapes the
           plugin iframe via `<base target="_parent">`. A button + location
           assignment would open Unraid's form inside the iframe. -->
      <a
        href="/Docker/AddContainer"
        role="menuitem"
        class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text transition cursor-pointer no-underline"
        @click="menuOpen = false"
      >
        <IconContainer :size="14" />
        Container
      </a>
      <button
        role="menuitem"
        :disabled="stackDisabled"
        :title="stackDisabledReason ?? undefined"
        class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text transition text-left border-none bg-transparent disabled:opacity-40 disabled:cursor-not-allowed"
        :class="stackDisabled ? '' : 'cursor-pointer'"
        @click="select('stack')"
      >
        <IconStack :size="14" />
        Stack
      </button>
      <button
        role="menuitem"
        class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text transition text-left border-none bg-transparent cursor-pointer"
        @click="select('folder')"
      >
        <IconFolder :size="14" />
        Folder
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import IconContainer from '@/components/icons/IconContainer.vue';
import IconStack from '@/components/icons/IconStack.vue';
import IconFolder from '@/components/icons/IconFolder.vue';

/**
 * `stackDisabled` greys the item out rather than hiding it — the compose
 * capability check resolves asynchronously, and a hidden item would make the
 * menu reflow under the pointer once it lands.
 */
withDefaults(
  defineProps<{
    stackDisabled?: boolean;
    stackDisabledReason?: string | null;
  }>(),
  { stackDisabled: false, stackDisabledReason: null },
);

const emit = defineEmits<{
  select: [action: 'stack' | 'folder'];
}>();

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function select(action: 'stack' | 'folder') {
  menuOpen.value = false;
  emit('select', action);
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

defineExpose({ menuOpen });
</script>
