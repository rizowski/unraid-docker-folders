<template>
  <div ref="menuRef" class="relative">
    <button
      ref="buttonRef"
      :class="buttonClass"
      :title="buttonTitle"
      @click.stop="toggleMenu"
    >
      <svg xmlns="http://www.w3.org/2000/svg" :width="iconSize" :height="iconSize" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
      </svg>
    </button>
    <div
      v-if="menuOpen"
      ref="dropdownRef"
      class="absolute right-0 bg-bg border border-border rounded-lg shadow-lg py-1.5 min-w-[160px] z-[100]"
      :class="resolvedPosition === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'"
      :style="maxHeight === null ? undefined : { maxHeight: `${maxHeight}px`, overflowY: 'auto' }"
    >
      <template v-for="(item, idx) in visibleItems" :key="item.label ?? `div-${idx}`">
        <hr
          v-if="item.divider"
          class="my-1 border-0 border-t border-border"
        />
        <a
          v-else-if="item.href"
          :href="item.href"
          :target="item.target"
          rel="noopener"
          class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition cursor-pointer no-underline"
          :class="item.class || 'text-text'"
          @click="menuOpen = false"
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
          @click="onSelect(item)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="(d, i) in (item.icon ?? '').split('|')" :key="i" :d="d" />
          </svg>
          {{ item.label }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';

export interface KebabMenuItem {
  label?: string;
  icon?: string;
  show?: boolean;
  /**
   * Render the item greyed out and inert. Prefer this over `show: false` for
   * actions that exist but are temporarily unavailable — hiding them makes the
   * menu reflow once an async capability check resolves.
   */
  disabled?: boolean;
  /** Tooltip, typically the reason an item is disabled. */
  title?: string;
  href?: string;
  target?: string;
  action?: string;
  class?: string;
  divider?: boolean;
}

interface Props {
  items: KebabMenuItem[];
  /**
   * Preferred side, not a guarantee. The menu flips to the other side when the
   * preferred one cannot hold it and the other has more room — see fitToViewport.
   */
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

const emit = defineEmits<{
  select: [action: string];
}>();

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const buttonRef = ref<HTMLElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);

/** The side actually used this time round; `position` is only the preference. */
const resolvedPosition = ref<'below' | 'above'>(props.position);
/** null = unclamped. A number means the menu scrolls inside that many pixels. */
const maxHeight = ref<number | null>(null);

/** Breathing room kept between the menu and the edge of the viewport. */
const EDGE_GAP = 8;
/** Below this a clamped menu shows too little to be worth flipping for. */
const MIN_USABLE_HEIGHT = 120;

async function toggleMenu() {
  if (menuOpen.value) {
    menuOpen.value = false;
    return;
  }
  // Reset before measuring: visibleItems changes per container, so last time's
  // side and clamp say nothing about this time's.
  resolvedPosition.value = props.position;
  maxHeight.value = null;
  menuOpen.value = true;
  await nextTick();
  fitToViewport();
}

/**
 * Keep the menu inside the viewport.
 *
 * On Unraid the app runs in an iframe whose height tracks the app's own content
 * (main.ts), so the viewport ends close to the last row. A menu opening off that
 * edge is either clipped or forces the page to scroll, which is what this
 * prevents: pick the roomier side, then cap the height so the menu scrolls
 * internally rather than off the end of the frame.
 */
function fitToViewport() {
  const button = buttonRef.value;
  const dropdown = dropdownRef.value;
  if (!button || !dropdown) return;

  // scrollHeight, not offsetHeight: once max-height is set offsetHeight reports
  // the clamp instead of the content. Zero means no layout (jsdom, or a hidden
  // ancestor) — leave placement to the prop rather than act on bogus numbers.
  const naturalHeight = dropdown.scrollHeight;
  if (naturalHeight <= 0) return;

  const rect = button.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - EDGE_GAP;
  const spaceAbove = rect.top - EDGE_GAP;

  const preferred = props.position;
  const preferredSpace = preferred === 'below' ? spaceBelow : spaceAbove;
  const otherSpace = preferred === 'below' ? spaceAbove : spaceBelow;

  const fitsPreferred = naturalHeight <= preferredSpace;
  const side = fitsPreferred || preferredSpace >= otherSpace
    ? preferred
    : preferred === 'below'
      ? 'above'
      : 'below';

  resolvedPosition.value = side;

  const space = side === 'below' ? spaceBelow : spaceAbove;
  maxHeight.value = naturalHeight > space ? Math.max(space, MIN_USABLE_HEIGHT) : null;
}

function onSelect(item: KebabMenuItem) {
  if (item.disabled) return;
  menuOpen.value = false;
  emit('select', item.action!);
}

const visibleItems = computed(() => {
  const shown = props.items.filter((item) => item.show !== false);
  // Collapse consecutive/leading/trailing dividers
  const result: KebabMenuItem[] = [];
  for (const item of shown) {
    if (item.divider) {
      if (result.length === 0) continue;
      if (result[result.length - 1].divider) continue;
      result.push(item);
    } else {
      result.push(item);
    }
  }
  while (result.length && result[result.length - 1].divider) result.pop();
  return result;
});

function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

onMounted(() => document.addEventListener('click', onClickOutside, true));
onUnmounted(() => document.removeEventListener('click', onClickOutside, true));

defineExpose({ menuOpen });
</script>
