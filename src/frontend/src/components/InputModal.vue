<template>
  <Transition name="modal">
  <div v-if="isOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" style="font-size: 16px; line-height: 1.5;" @click="$emit('cancel')">
    <div class="modal-content bg-bg-card rounded-lg shadow-lg max-w-[400px] w-[90%]" @click.stop>
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
    </div>
  </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

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

watch(() => props.isOpen, (open) => {
  if (open) {
    inputValue.value = props.initialValue;
    nextTick(() => {
      inputEl.value?.focus();
      inputEl.value?.select();
    });
  }
});

function handleConfirm() {
  emit('confirm', inputValue.value);
}
</script>
