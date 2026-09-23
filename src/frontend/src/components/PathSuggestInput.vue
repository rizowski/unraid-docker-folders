<template>
  <div class="flex flex-col gap-1">
    <input
      :id="inputId"
      ref="inputEl"
      :value="modelValue"
      class="form-input compact mono"
      :placeholder="placeholder"
      role="combobox"
      aria-autocomplete="list"
      autocomplete="off"
      :aria-expanded="isOpen"
      :aria-controls="listId"
      :aria-activedescendant="isOpen && active >= 0 ? `${listId}-${active}` : undefined"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />

    <!-- In normal flow on purpose. BaseModal's content element scrolls
         (max-height + overflow: auto), so an absolutely positioned list under
         the last field would be clipped by it. Pushing the following fields
         down costs nothing and needs no z-index or teleport. -->
    <ul
      v-if="isOpen && shownEntries.length"
      :id="listId"
      class="flex flex-col gap-0 m-0 p-0 list-none border border-border rounded bg-bg-card max-h-40 overflow-auto"
      role="listbox"
    >
      <li v-for="(entry, idx) in shownEntries" :key="entry.path" role="presentation">
        <button
          :id="`${listId}-${idx}`"
          type="button"
          role="option"
          :aria-selected="idx === active"
          class="kebab-menu-item block w-full text-left mono truncate"
          :class="{ 'kebab-menu-item-open': idx === active }"
          @mousedown.prevent="accept(entry)"
        >
          {{ entry.name }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, useId } from 'vue';
import { useBackend } from '@/backends';
import type { PathSuggestion } from '@/types/schedule';

// Long enough that typing a full path is one request per pause, short enough
// that the list feels attached to the keyboard.
const KEYSTROKE_DELAY_MS = 200;

interface Props {
  modelValue: string;
  /** 'host' lists real directories, 'container' lists paths as the container sees them. */
  scope: 'host' | 'container';
  /** Container name, or a compose service name when project is set. */
  container?: string;
  /** Compose project. A stack's service name is not the container's name. */
  project?: string;
  placeholder?: string;
  inputId?: string;
  /** Shown before the first response arrives, and if a request fails. */
  seed?: string[];
}

const props = withDefaults(defineProps<Props>(), {
  container: '',
  project: '',
  placeholder: '',
  inputId: undefined,
  seed: () => [],
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** True when the directory now being listed holds a database file. */
  sqlite: [present: boolean];
}>();

const listId = useId();
const inputEl = ref<HTMLInputElement | null>(null);
const entries = ref<PathSuggestion[]>([]);
const isOpen = ref(false);
const active = ref(-1);
const fetched = ref(false);

let timer: ReturnType<typeof setTimeout> | null = null;
// Only the newest request may write to entries. A slow listing of a big share
// would otherwise land after a later, narrower one and replace it.
let requestId = 0;

const seedEntries = computed<PathSuggestion[]>(() => {
  const typed = props.modelValue.trim();
  return props.seed
    .filter((p) => !typed || p.toLowerCase().startsWith(typed.toLowerCase()))
    .map((p) => ({ name: p, path: p }));
});

const shownEntries = computed(() => (fetched.value && entries.value.length ? entries.value : seedEntries.value));

function cancelTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function load() {
  if (props.scope === 'container' && !props.container) {
    return;
  }

  const mine = ++requestId;
  const params = new URLSearchParams({ scope: props.scope, path: props.modelValue });
  if (props.scope === 'container') {
    params.set('container', props.container);
    if (props.project) {
      params.set('project', props.project);
    }
  }

  try {
    const { ok, error: failure, data } = await useBackend().paths.list(
      Object.fromEntries(params.entries()),
    );
    if (!ok) throw new Error(failure);
    if (mine !== requestId) return;

    entries.value = data.entries || [];
    fetched.value = true;
    active.value = -1;
    emit('sqlite', Boolean(data.has_sqlite));
  } catch (e) {
    if (mine !== requestId) return;
    // A failed listing falls back to the seed rather than an empty list. The
    // field still accepts anything typed by hand.
    entries.value = [];
    console.error('Error fetching path suggestions:', e);
  }
}

function schedule() {
  cancelTimer();
  timer = setTimeout(() => {
    timer = null;
    load();
  }, KEYSTROKE_DELAY_MS);
}

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
  fetched.value = false;
  isOpen.value = true;
  schedule();
}

function onFocus() {
  isOpen.value = true;

  // Clicking away and back asks for a listing this component already holds.
  // One request there costs a Docker socket call and a directory scan on the
  // box, so the cached entries are reopened instead.
  if (fetched.value) {
    return;
  }

  load();
}

function onBlur() {
  isOpen.value = false;
  active.value = -1;
}

function accept(entry: PathSuggestion) {
  // A trailing slash both commits the folder and asks for its contents, so one
  // key walks down the tree the way Unraid's own field does.
  emit('update:modelValue', `${entry.path}/`);
  fetched.value = false;
  active.value = -1;
  inputEl.value?.focus();
  cancelTimer();
  load();
}

function move(step: number) {
  const total = shownEntries.value.length;
  if (!total) return;
  isOpen.value = true;
  active.value = (active.value + step + total) % total;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === 'Escape') {
    isOpen.value = false;
    active.value = -1;
    return;
  }

  const chosen = isOpen.value && active.value >= 0 ? shownEntries.value[active.value] : null;
  if (!chosen) return;

  if (event.key === 'Enter' || event.key === 'Tab') {
    // Enter would otherwise submit, and Tab would leave the field with the
    // highlighted entry discarded.
    event.preventDefault();
    accept(chosen);
  }
}

// A stack row names its container by service, and the user types that name
// too. The listing belongs to the old service, so onFocus must ask again.
watch([() => props.container, () => props.project], () => {
  fetched.value = false;
});

onBeforeUnmount(cancelTimer);
</script>
