<template>
  <div v-if="isOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" @click="handleOverlayClick">
    <div class="bg-bg-card rounded-lg shadow-lg max-w-[500px] w-[90%] max-h-[90vh] overflow-auto" @click.stop>
      <div class="flex justify-between items-center p-6 border-b border-border">
        <h2 class="text-2xl font-semibold">{{ isEditing ? 'Edit Folder' : 'Create Folder' }}</h2>
        <button class="bg-transparent border-none text-[32px] cursor-pointer text-text-secondary leading-none p-0 w-8 h-8 hover:text-text" @click="$emit('close')" aria-label="Close">&times;</button>
      </div>

      <form @submit.prevent="handleSubmit" class="p-6">
        <div class="mb-6">
          <label for="folder-name" class="block mb-1 font-medium text-text">Folder Name *</label>
          <input
            id="folder-name"
            v-model="formData.name"
            type="text"
            required
            placeholder="Enter folder name"
            class="w-full py-2 px-4 border border-input-border rounded bg-input-bg text-base font-[inherit] focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            autofocus
          />
        </div>

        <div class="mb-6">
          <label for="folder-icon" class="block mb-1 font-medium text-text">Icon (emoji)</label>
          <input
            id="folder-icon"
            v-model="formData.icon"
            type="text"
            placeholder="📁"
            class="w-full py-2 px-4 border border-input-border rounded bg-input-bg text-base font-[inherit] focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            maxlength="2"
          />
          <span class="block mt-1 text-sm text-text-secondary">Enter an emoji to use as the folder icon</span>
        </div>

        <div class="mb-6">
          <label for="folder-color" class="block mb-1 font-medium text-text">Color</label>
          <div class="flex gap-2 items-center">
            <input id="folder-color" v-model="formData.color" type="color" class="w-[60px] h-10 border border-input-border rounded cursor-pointer" />
            <input
              v-model="formData.color"
              type="text"
              placeholder="#ff8c2f"
              class="flex-1 py-2 px-4 border border-input-border rounded bg-input-bg text-base font-[inherit] focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
              pattern="^#[0-9A-Fa-f]{6}$"
            />
          </div>
          <span class="block mt-1 text-sm text-text-secondary">Choose a color for the folder's left border</span>
        </div>

        <div class="flex justify-end gap-2 pt-6 border-t border-border">
          <button type="button" @click="$emit('close')" class="py-2 px-6 border-none rounded text-base font-medium cursor-pointer bg-border text-text hover:brightness-90 transition">Cancel</button>
          <button type="submit" class="py-2 px-6 border-none rounded text-base font-medium cursor-pointer bg-button text-button-text hover:bg-button-hover transition disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!formData.name">{{ isEditing ? 'Save Changes' : 'Create Folder' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { Folder, FolderCreateData, FolderUpdateData } from '@/types/folder';

interface Props {
  isOpen: boolean;
  folder?: Folder | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  save: [data: FolderCreateData | FolderUpdateData];
}>();

const isEditing = computed(() => !!props.folder);

const formData = ref({
  name: '',
  icon: '📁',
  color: '#ff8c2f',
});

// Reset form when modal opens/closes or folder changes
watch(
  () => [props.isOpen, props.folder],
  () => {
    if (props.isOpen && props.folder) {
      // Editing existing folder
      formData.value = {
        name: props.folder.name,
        icon: props.folder.icon || '📁',
        color: props.folder.color || '#ff8c2f',
      };
    } else if (props.isOpen) {
      // Creating new folder
      formData.value = {
        name: '',
        icon: '📁',
        color: '#ff8c2f',
      };
    }
  },
  { immediate: true }
);

function handleOverlayClick() {
  emit('close');
}

function handleSubmit() {
  emit('save', formData.value);
}
</script>
