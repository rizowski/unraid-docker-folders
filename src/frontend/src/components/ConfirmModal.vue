<template>
  <Transition name="modal">
  <div v-if="isOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" style="font-size: 16px; line-height: 1.5;" @click="$emit('cancel')">
    <div class="modal-content bg-bg-card rounded-lg shadow-lg max-w-[400px] w-[90%]" @click.stop>
      <div class="flex items-center gap-3 p-4 sm:p-6 pb-2">
        <div
          v-if="variant === 'danger'"
          class="flex items-center justify-center w-10 h-10 rounded-full bg-error/15 shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-error">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div
          v-else
          class="flex items-center justify-center w-10 h-10 rounded-full bg-primary/15 shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-primary">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div>
          <h3 class="text-base font-semibold text-text">{{ title }}</h3>
          <p class="text-sm text-text-secondary mt-1">{{ message }}</p>
        </div>
      </div>
      <div class="flex justify-end gap-2 p-4 sm:p-6 pt-4">
        <button
          ref="cancelBtn"
          type="button"
          @click="$emit('cancel')"
          class="py-2 px-5 border-none rounded text-sm font-medium cursor-pointer bg-border text-text hover:brightness-90 transition"
        >
          Cancel
        </button>
        <button
          ref="confirmBtn"
          type="button"
          @click="$emit('confirm')"
          class="py-2 px-5 border-none rounded text-sm font-medium cursor-pointer transition"
          :class="variant === 'danger' ? 'bg-error text-white hover:brightness-90' : 'bg-primary text-primary-text hover:brightness-90'"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
  </Transition>
</template>

<script setup lang="ts">
import { watch, ref, nextTick } from 'vue';

interface Props {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'default';
}

const props = withDefaults(defineProps<Props>(), {
  confirmLabel: 'Confirm',
  variant: 'default',
});

defineEmits<{
  confirm: [];
  cancel: [];
}>();

const confirmBtn = ref<HTMLButtonElement | null>(null);

watch(() => props.isOpen, (open) => {
  if (open) {
    nextTick(() => confirmBtn.value?.focus());
  }
});
</script>
