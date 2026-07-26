<template>
  <!-- Thin wrapper so the schedule form can also be opened as a standalone
       modal (SchedulesPanel). ScheduleList embeds ScheduleForm inline instead,
       to avoid stacking a modal on top of a modal. -->
  <BaseModal :is-open="isOpen" max-width="560px" @close="$emit('close')">
    <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border">
      <h2 class="text-xl font-semibold text-text m-0">{{ editId ? 'Edit Schedule' : 'New Schedule' }}</h2>
      <button
        class="icon-btn icon-btn-round text-text-secondary hover:text-text"
        aria-label="Close"
        @click="$emit('close')"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>

    <div class="p-4 sm:p-6">
      <ScheduleForm
        :key="editId ?? 'new'"
        :target-type="targetType"
        :target-id="targetId"
        :edit-id="editId"
        embedded
        @cancel="$emit('close')"
        @saved="onSaved"
      />
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import BaseModal from '@/components/BaseModal.vue';
import ScheduleForm from './ScheduleForm.vue';
import type { TargetType } from '@/types/schedule';

interface Props {
  isOpen: boolean;
  targetType: TargetType;
  targetId: string;
  editId?: number | null;
}

withDefaults(defineProps<Props>(), { editId: null });
const emit = defineEmits<{ close: []; saved: [] }>();

function onSaved() {
  emit('saved');
  emit('close');
}
</script>
