<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="512px" @close="$emit('cancel')">
    <div class="px-6 py-4 border-b border-border">
      <h2 class="text-base font-semibold text-text">Update Containers</h2>
      <p class="text-sm text-text-secondary mt-1">{{ summary }}</p>
    </div>

    <div class="max-h-[320px] overflow-auto">
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
        </span>
        <span
          v-if="unit.kind === 'compose'"
          class="shrink-0 mt-0.5 px-2 py-0.5 rounded text-xs font-medium border border-border text-text-secondary"
        >stack</span>
      </label>
    </div>

    <div class="flex justify-end gap-2 px-6 py-3 border-t border-border">
      <button type="button" @click="$emit('cancel')" class="nav-btn">Cancel</button>
      <button
        ref="confirmBtn"
        type="button"
        @click="confirm"
        class="nav-btn active"
        :class="{ 'opacity-50 cursor-not-allowed': selected.size === 0 }"
        :disabled="selected.size === 0"
      >Update</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useParentModal } from '@/composables/useParentModal';
import { unitLabel, type UpdateUnit } from '@/utils/updateUnits';

interface Props {
  isOpen: boolean;
  units: UpdateUnit[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  confirm: [units: UpdateUnit[]];
  cancel: [];
}>();

const selected = ref(new Set<string>());
const confirmBtn = ref<HTMLButtonElement | null>(null);

const containerCount = computed(() =>
  props.units.reduce((total, unit) => total + unit.containers.length, 0),
);

const summary = computed(() => {
  const n = containerCount.value;
  return n === 1
    ? '1 container will be updated.'
    : `${n} containers will be updated.`;
});

function containerNames(unit: UpdateUnit): string {
  return unit.containers.map((c) => c.name).join(', ');
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

function openParent() {
  parentModal.open({
    kind: 'update-confirm',
    title: 'Update Containers',
    size: 'md',
    fields: [
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
          state: unit.kind === 'compose' ? 'stack' : undefined,
          checked: true,
        })),
      },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'default' },
      { id: 'confirm', label: 'Update', variant: 'primary' },
    ],
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
</script>
