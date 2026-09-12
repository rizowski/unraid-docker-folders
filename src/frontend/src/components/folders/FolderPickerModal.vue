<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="400px" @close="$emit('cancel')">
    <div class="p-4 sm:p-6 pb-2">
      <h3 class="text-base font-semibold text-text">{{ title }}</h3>
      <p v-if="description" class="text-sm text-text-secondary mt-1">{{ description }}</p>
    </div>
    <div class="px-4 sm:px-6 py-3">
      <select ref="selectEl" v-model="selected" class="form-input w-full" aria-label="Folder">
        <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>
    <div class="flex justify-end gap-2 p-4 sm:p-6 pt-2">
      <button type="button" @click="$emit('cancel')" class="nav-btn">Cancel</button>
      <button type="button" @click="handleConfirm" class="nav-btn active">{{ confirmLabel }}</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useParentModal } from '@/composables/useParentModal';

export interface FolderPickerOption {
  value: string;
  label: string;
}

interface Props {
  isOpen: boolean;
  title: string;
  options: FolderPickerOption[];
  description?: string;
  initialValue?: string;
  confirmLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  initialValue: '',
  confirmLabel: 'Move',
});

const emit = defineEmits<{
  confirm: [value: string];
  cancel: [];
}>();

const selectEl = ref<HTMLSelectElement | null>(null);
const selected = ref(props.initialValue);

const parentModal = useParentModal({
  onAction({ actionId, values }) {
    if (actionId === 'confirm') {
      const v = values.folder;
      emit('confirm', typeof v === 'string' ? v : String(v ?? ''));
    } else {
      emit('cancel');
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'folder-picker',
    title: props.title,
    size: 'sm',
    fields: [
      ...(props.description ? [{ type: 'text' as const, text: props.description, variant: 'muted' as const }] : []),
      {
        type: 'select',
        id: 'folder',
        value: props.initialValue,
        options: props.options,
      },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'default' },
      { id: 'confirm', label: props.confirmLabel, variant: 'primary' },
    ],
  });
}

function handleConfirm() {
  emit('confirm', selected.value);
}

watch(() => props.isOpen, (open) => {
  if (inIframe) {
    if (open) openParent();
    else parentModal.close();
  } else if (open) {
    selected.value = props.initialValue;
    nextTick(() => selectEl.value?.focus());
  }
}, { immediate: true });
</script>
