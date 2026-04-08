<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="400px" @close="$emit('cancel')">
    <div class="p-4 sm:p-6 pb-2">
      <h3 class="text-base font-semibold text-text">{{ title }}</h3>
      <p v-if="description" class="text-sm text-text-secondary mt-1">{{ description }}</p>
    </div>
    <div class="px-4 sm:px-6 py-3">
      <input
        ref="inputEl"
        v-model="inputValue"
        :type="inputType"
        :placeholder="placeholder"
        class="styled-input w-full"
        @keydown.enter="handleConfirm"
      />
      <p v-if="suffix" class="text-xs text-text-secondary mt-1">{{ suffix }}</p>
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

interface Props {
  isOpen: boolean;
  title: string;
  description?: string;
  initialValue?: string;
  placeholder?: string;
  suffix?: string;
  inputType?: string;
  confirmLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  initialValue: '',
  placeholder: '',
  suffix: '',
  inputType: 'text',
  confirmLabel: 'Save',
});

const emit = defineEmits<{
  confirm: [value: string];
  cancel: [];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const inputValue = ref(props.initialValue);

const parentModal = useParentModal({
  onAction({ actionId, values }) {
    if (actionId === 'confirm') {
      const v = typeof values.value === 'string' ? values.value : '';
      emit('confirm', v);
    } else {
      emit('cancel');
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'input',
    title: props.title,
    size: 'sm',
    fields: [
      ...(props.description ? [{ type: 'text' as const, text: props.description, variant: 'muted' as const }] : []),
      {
        type: 'input',
        id: 'value',
        value: props.initialValue,
        placeholder: props.placeholder,
        inputType: props.inputType,
        autofocus: true,
        suffix: props.suffix || undefined,
      },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'default' },
      { id: 'confirm', label: props.confirmLabel, variant: 'primary' },
    ],
  });
}

function handleConfirm() {
  emit('confirm', inputValue.value);
}

watch(() => props.isOpen, (open) => {
  if (inIframe) {
    if (open) openParent();
    else parentModal.close();
  } else if (open) {
    inputValue.value = props.initialValue;
    nextTick(() => {
      inputEl.value?.focus();
      inputEl.value?.select();
    });
  }
}, { immediate: true });
</script>
