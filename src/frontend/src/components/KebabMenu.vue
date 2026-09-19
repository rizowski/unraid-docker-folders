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
        <!-- Submenu parent. Hover opens it with a mouse; a click toggles it,
             which is the only way in on touch. -->
        <button
          v-else-if="item.children"
          :ref="(el) => setSubParent(el, idx)"
          aria-haspopup="menu"
          :aria-expanded="openSub === idx"
          class="kebab-menu-item flex items-center gap-2.5 w-full px-3 py-2 text-sm transition text-left border-none bg-transparent cursor-pointer"
          :class="[item.class || 'text-text', openSub === idx ? 'kebab-menu-item-open' : '']"
          @pointerenter="onParentEnter($event, idx)"
          @click="toggleSub(idx)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path v-for="(d, i) in (item.icon ?? '').split('|')" :key="i" :d="d" />
          </svg>
          <span class="flex-1 whitespace-nowrap">{{ item.label }}</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-text-secondary">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <KebabMenuRow v-else :item="item" @pointerenter="onLeafEnter" @select="onSelect" />
      </template>
    </div>
    <!-- A sibling of the dropdown, not a child: the dropdown scrolls when
         clamped, and a scroll container clips anything placed outside it. -->
    <div
      v-if="openSubItems"
      ref="subRef"
      role="menu"
      class="absolute bg-bg border border-border rounded-lg shadow-lg py-1.5 min-w-[160px] whitespace-nowrap z-[100]"
      :style="subStyle"
      @pointerenter="cancelSubTimer"
    >
      <template v-for="(child, cidx) in openSubItems" :key="child.label ?? `sub-div-${cidx}`">
        <hr v-if="child.divider" class="my-1 border-0 border-t border-border" />
        <KebabMenuRow v-else :item="child" @select="onSelect" />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, type CSSProperties } from 'vue';
import KebabMenuRow from './KebabMenuRow.vue';

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
  /**
   * Makes the item a submenu parent that opens a flyout of these items. The
   * parent itself has no action. It hides when none of its children show.
   */
  children?: KebabMenuItem[];
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
  /**
   * Flip and clamp the menu to fit the viewport. Turn off when the host grows
   * the iframe to hold the menu instead (the dashboard widget does).
   */
  fitViewport?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  position: 'below',
  buttonTitle: 'More actions',
  buttonClass: 'p-1.5 rounded cursor-pointer text-text-secondary hover:text-text transition',
  iconSize: 16,
  fitViewport: true,
});

const emit = defineEmits<{
  select: [action: string];
  /** `bottom` is the page y of the open menu's lower edge plus EDGE_GAP, or 0 when closed. */
  'open-change': [open: boolean, bottom: number];
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
  if (props.fitViewport) fitToViewport();
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
  // Links navigate on their own; only action items report a selection.
  if (!item.href) emit('select', item.action!);
}

// --- Submenus ---------------------------------------------------------------

/** Index into visibleItems of the parent whose flyout is open. */
const openSub = ref<number | null>(null);
const subParentRef = ref<HTMLElement | null>(null);
const subRef = ref<HTMLElement | null>(null);
const subStyle = ref<CSSProperties>({});

/**
 * Grace period before hover moves the flyout. The pointer crosses sibling rows
 * on its way diagonally from a parent to its flyout, and switching on every
 * row it touches would close the flyout before the pointer arrives.
 */
const SUB_HOVER_DELAY = 150;
const SUB_GAP = 4;
let subTimer: ReturnType<typeof setTimeout> | null = null;

const openSubItems = computed(() => {
  if (openSub.value === null) return null;
  const children = visibleItems.value[openSub.value]?.children;
  return children ? tidy(children) : null;
});

function setSubParent(el: unknown, idx: number) {
  if (openSub.value === idx) subParentRef.value = el as HTMLElement | null;
}

function cancelSubTimer() {
  if (subTimer) clearTimeout(subTimer);
  subTimer = null;
}

async function showSub(idx: number | null) {
  cancelSubTimer();
  if (openSub.value === idx) return;
  // Hidden until placed, so it never flashes at the wrong spot.
  subStyle.value = { visibility: 'hidden', top: '0px', left: '0px' };
  openSub.value = idx;
  if (idx === null) return;
  await nextTick();
  placeSub();
}

function onParentEnter(e: PointerEvent, idx: number) {
  // Touch and pen fire pointerenter just before click, and the click toggles.
  if (e.pointerType !== 'mouse') return;
  cancelSubTimer();
  if (openSub.value === null) void showSub(idx);
  else if (openSub.value !== idx) subTimer = setTimeout(() => void showSub(idx), SUB_HOVER_DELAY);
}

function onLeafEnter() {
  cancelSubTimer();
  if (openSub.value !== null) subTimer = setTimeout(() => void showSub(null), SUB_HOVER_DELAY);
}

function toggleSub(idx: number) {
  void showSub(openSub.value === idx ? null : idx);
}

/**
 * Put the flyout beside the menu, level with its parent row. It prefers the
 * left side because every kebab sits at the right edge of its row, and flips
 * right only when the left has no room. Vertically it shifts up to stay in the
 * viewport, then scrolls if it is taller than the viewport.
 */
function placeSub() {
  const parent = subParentRef.value;
  const sub = subRef.value;
  const menu = dropdownRef.value;
  const wrapper = menuRef.value;
  if (!parent || !sub || !menu || !wrapper) return;

  // Worked out in viewport coordinates, then made relative to the wrapper,
  // which is the flyout's containing block.
  const origin = wrapper.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const rowRect = parent.getBoundingClientRect();
  const width = sub.offsetWidth;
  const height = sub.scrollHeight;

  const leftSide = menuRect.left - SUB_GAP - width;
  const left = leftSide >= EDGE_GAP || menuRect.right + SUB_GAP + width > window.innerWidth
    ? Math.max(leftSide, EDGE_GAP)
    : menuRect.right + SUB_GAP;

  const room = window.innerHeight - 2 * EDGE_GAP;
  const style: CSSProperties = { left: `${left - origin.left}px` };
  if (height > room) {
    style.top = `${EDGE_GAP - origin.top}px`;
    style.maxHeight = `${room}px`;
    style.overflowY = 'auto';
  } else {
    // Align the first child with the parent row, net of the flyout's padding.
    const padTop = parseFloat(getComputedStyle(sub).paddingTop) || 0;
    const top = Math.min(rowRect.top - padTop, window.innerHeight - EDGE_GAP - height);
    style.top = `${Math.max(top, EDGE_GAP) - origin.top}px`;
  }
  subStyle.value = style;
}

// The flyout is placed once, so close it rather than let it drift from its
// parent row when the dropdown scrolls under it.
function onScroll(e: Event) {
  if (openSub.value !== null && !subRef.value?.contains(e.target as Node)) void showSub(null);
}

watch(menuOpen, (open) => {
  if (!open) void showSub(null);
});

// Post-flush so the dropdown is laid out by the time an open is reported.
watch(menuOpen, (open) => {
  const dropdown = open ? dropdownRef.value : null;
  const bottom = dropdown ? Math.ceil(dropdown.getBoundingClientRect().bottom + window.scrollY + EDGE_GAP) : 0;
  emit('open-change', open, bottom);
}, { flush: 'post' });

/**
 * Drop hidden items, and dividers that would sit first, last, or next to
 * another divider. Submenu parents with nothing to open are hidden too.
 */
function tidy(items: KebabMenuItem[]): KebabMenuItem[] {
  const result: KebabMenuItem[] = [];
  for (const item of items) {
    if (item.show === false) continue;
    if (item.children && !item.children.some((c) => c.show !== false && !c.divider)) continue;
    if (item.divider && (result.length === 0 || result[result.length - 1].divider)) continue;
    result.push(item);
  }
  while (result.length && result[result.length - 1].divider) result.pop();
  return result;
}

const visibleItems = computed(() => tidy(props.items));

function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside, true);
  document.addEventListener('scroll', onScroll, true);
});
onUnmounted(() => {
  document.removeEventListener('click', onClickOutside, true);
  document.removeEventListener('scroll', onScroll, true);
  cancelSubTimer();
});

defineExpose({ menuOpen });
</script>
