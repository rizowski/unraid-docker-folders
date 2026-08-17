<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="512px" @close="$emit('cancel')">
    <div class="px-6 py-4 border-b border-border">
      <h2 class="text-base font-semibold text-text">Update Containers</h2>
      <p v-if="!isEmpty" class="text-sm text-text-secondary mt-1">{{ summary }}</p>
    </div>

    <p v-if="isEmpty" class="px-6 py-6 text-sm text-text-secondary">
      Everything is up to date.
    </p>

    <div v-else class="max-h-[320px] overflow-auto">
      <label
        v-for="unit in units"
        :key="unit.id"
        class="flex items-start gap-3 px-6 py-2 cursor-pointer border-b border-border/30 hover:bg-bg-card transition-colors"
      >
        <input
          type="checkbox"
          :checked="selected.has(unit.id)"
          @change="toggle(unit.id)"
          class="shrink-0 mt-0.5"
        />
        <span class="min-w-0 flex-1">
          <span class="block text-sm text-text truncate">{{ containerNames(unit) }}</span>
          <span class="block text-xs text-text-secondary font-mono truncate">{{ unitLabel(unit) }}</span>
          <span v-if="noteFor(unit)" class="flex items-center gap-1 min-w-0">
            <span class="text-xs text-text-secondary truncate" :title="noteFor(unit) || undefined">{{ noteFor(unit) }}</span>
            <a
              v-if="urlFor(unit)"
              :href="urlFor(unit) || undefined"
              target="_blank"
              rel="noopener noreferrer"
              class="shrink-0 text-text-secondary hover:text-text"
              title="View release notes"
              aria-label="View release notes"
              @click.stop
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </a>
          </span>
        </span>
        <span
          v-if="unit.kind === 'compose'"
          class="shrink-0 mt-0.5 px-2 py-0.5 rounded text-xs font-medium border border-border text-text-secondary"
        >stack</span>
      </label>
    </div>

    <div v-if="isEmpty" class="flex justify-end gap-2 px-6 py-3 border-t border-border">
      <button type="button" @click="$emit('cancel')" class="nav-btn active">Close</button>
    </div>
    <div v-else class="flex items-center gap-2 px-6 py-3 border-t border-border">
      <button
        v-if="canRecheck"
        type="button"
        @click="$emit('recheck')"
        class="nav-btn"
        :class="{ 'opacity-50 cursor-not-allowed': checking }"
        :disabled="checking"
      >{{ checking ? 'Checking…' : 'Check Again' }}</button>
      <span class="flex-1"></span>
      <button type="button" @click="$emit('cancel')" class="nav-btn" :disabled="checking">Cancel</button>
      <button
        ref="confirmBtn"
        type="button"
        @click="confirm"
        class="nav-btn active"
        :class="{ 'opacity-50 cursor-not-allowed': selected.size === 0 || checking }"
        :disabled="selected.size === 0 || checking"
      >Update</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useParentModal, type ModalAction } from '@/composables/useParentModal';
import { useUpdatesStore } from '@/stores/updates';
import { unitLabel, unitReleaseSummary, unitReleaseUrl, type UpdateUnit } from '@/utils/updateUnits';

interface Props {
  isOpen: boolean;
  units: UpdateUnit[];
  /**
   * Offer "Check Again". Only set when the modal covers every container — a
   * re-check rebuilds the list from everything with an update, which would
   * widen a folder or single-container list into a global one.
   */
  canRecheck?: boolean;
  /** A re-check is in flight; the footer locks while it runs. */
  checking?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  canRecheck: false,
  checking: false,
});

const emit = defineEmits<{
  confirm: [units: UpdateUnit[]];
  recheck: [];
  cancel: [];
}>();

const selected = ref(new Set<string>());
const confirmBtn = ref<HTMLButtonElement | null>(null);

const containerCount = computed(() =>
  props.units.reduce((total, unit) => total + unit.containers.length, 0),
);

/**
 * A re-check can empty the list. The modal stays open on this state rather
 * than vanishing, so the click has a visible result.
 */
const isEmpty = computed(() => props.units.length === 0);

const summary = computed(() => {
  const n = containerCount.value;
  return n === 1
    ? '1 container will be updated.'
    : `${n} containers will be updated.`;
});

function containerNames(unit: UpdateUnit): string {
  return unit.containers.map((c) => c.name).join(', ');
}

const updatesStore = useUpdatesStore();

/**
 * Cached release notes for what this unit will pull, or null when we have
 * none — the row then looks exactly as it did before notes existed. Reads
 * cache only; the modal never waits on a network call to open.
 */
function noteFor(unit: UpdateUnit): string | null {
  return unitReleaseSummary(unit, updatesStore.updates);
}

/**
 * The row's link to the full notes. Null for units pulling several images —
 * see unitReleaseUrl. The summary is capped server-side, so this is how the
 * untruncated notes are reached.
 */
function urlFor(unit: UpdateUnit): string | null {
  return unitReleaseUrl(unit, updatesStore.updates);
}

function toggle(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function selectedUnits(ids: Iterable<string>): UpdateUnit[] {
  const wanted = new Set(ids);
  return props.units.filter((u) => wanted.has(u.id));
}

function confirm() {
  const units = selectedUnits(selected.value);
  if (units.length === 0) return;
  emit('confirm', units);
}

const parentModal = useParentModal({
  onAction({ actionId, values }) {
    // Must come before the catch-all below, which reads every other action as
    // a dismissal — "Check Again" would otherwise close the modal.
    if (actionId === 'recheck') {
      emit('recheck');
      return;
    }
    if (actionId !== 'confirm') {
      emit('cancel');
      return;
    }
    const ids = Array.isArray(values.units) ? (values.units as string[]) : [];
    const units = selectedUnits(ids);
    if (units.length === 0) return;
    emit('confirm', units);
  },
});

const { inIframe } = parentModal;

/**
 * The parent renderer can only patch a checkbox-list's *checked* flags — it
 * cannot add or remove rows (`DockerFoldersMain.page:1128-1134`). So the
 * actions, which it can re-render, live here separately from the fields, which
 * need a full re-open when the unit list changes.
 */
const parentActions = computed<ModalAction[]>(() => {
  if (isEmpty.value) {
    return [{ id: 'cancel', label: 'Close', variant: 'primary' }];
  }
  const actions: ModalAction[] = [];
  if (props.canRecheck) {
    actions.push({
      id: 'recheck',
      label: props.checking ? 'Checking…' : 'Check Again',
      variant: 'default',
      disabled: props.checking,
    });
  }
  actions.push(
    { id: 'cancel', label: 'Cancel', variant: 'default', disabled: props.checking },
    { id: 'confirm', label: 'Update', variant: 'primary', disabled: props.checking },
  );
  return actions;
});

function openParent() {
  parentModal.open({
    kind: 'update-confirm',
    title: 'Update Containers',
    size: 'md',
    fields: isEmpty.value
      ? [{ type: 'text', text: 'Everything is up to date.' }]
      : [
          { type: 'text', text: summary.value },
          {
            type: 'checkbox-list',
            id: 'units',
            caption: 'Uncheck anything you want to skip.',
            items: props.units.map((unit) => ({
              id: unit.id,
              // The parent renderer gives items a single label line plus a small
              // state badge, so fold the image/project into the label rather than
              // dropping it.
              label: `${containerNames(unit)} — ${unitLabel(unit)}`,
              sublabel: noteFor(unit) ?? undefined,
              sublabelUrl: urlFor(unit) ?? undefined,
              state: unit.kind === 'compose' ? 'stack' : undefined,
              checked: true,
            })),
          },
        ],
    actions: parentActions.value,
  });
}

watch(
  () => [props.isOpen, props.units] as const,
  ([open]) => {
    if (open) {
      // Everything starts checked; the list is informational first, opt-out second.
      selected.value = new Set(props.units.map((u) => u.id));
    }
    if (inIframe) {
      if (open) openParent();
      else parentModal.close();
    } else if (open) {
      nextTick(() => confirmBtn.value?.focus());
    }
  },
  { immediate: true },
);

// A check flipping in or out only changes the buttons, so patch them rather
// than rebuilding the whole modal and losing the user's checkbox state.
watch(
  () => props.checking,
  () => {
    if (inIframe && props.isOpen) parentModal.update({ actions: parentActions.value });
  },
);
</script>
