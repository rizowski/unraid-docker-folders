<template>
  <div v-if="isOpen" class="modal-overlay" @click="handleOverlayClick">
    <div class="modal-content" @click.stop>
      <div class="modal-header">
        <h2>{{ isEditing ? 'Edit Folder' : 'Create Folder' }}</h2>
        <button class="close-btn" @click="$emit('close')" aria-label="Close">×</button>
      </div>

      <form @submit.prevent="handleSubmit" class="modal-body">
        <div class="form-group">
          <label for="folder-name">Folder Name *</label>
          <input id="folder-name" v-model="formData.name" type="text" required placeholder="Enter folder name" class="form-input" autofocus />
        </div>

        <div class="form-group">
          <label for="folder-icon">Icon (emoji)</label>
          <input id="folder-icon" v-model="formData.icon" type="text" placeholder="📁" class="form-input" maxlength="2" />
          <span class="help-text">Enter an emoji to use as the folder icon</span>
        </div>

        <div class="form-group">
          <label for="folder-color">Color</label>
          <div class="color-picker">
            <input id="folder-color" v-model="formData.color" type="color" class="color-input" />
            <input v-model="formData.color" type="text" placeholder="#2196f3" class="form-input color-text" pattern="^#[0-9A-Fa-f]{6}$" />
          </div>
          <span class="help-text">Choose a color for the folder's left border</span>
        </div>

        <div class="modal-footer">
          <button type="button" @click="$emit('close')" class="btn btn-secondary">Cancel</button>
          <button type="submit" class="btn btn-primary" :disabled="!formData.name">{{ isEditing ? 'Save Changes' : 'Create Folder' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
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
  color: '#2196f3',
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
        color: props.folder.color || '#2196f3',
      };
    } else if (props.isOpen) {
      // Creating new folder
      formData.value = {
        name: '',
        icon: '📁',
        color: '#2196f3',
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

<script lang="ts">
import { computed } from 'vue';
export default {
  name: 'FolderEditModal',
};
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  max-width: 500px;
  width: 90%;
  max-height: 90vh;
  overflow: auto;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-xl);
}

.close-btn {
  background: none;
  border: none;
  font-size: 32px;
  cursor: pointer;
  color: var(--color-text-secondary);
  line-height: 1;
  padding: 0;
  width: 32px;
  height: 32px;
}

.close-btn:hover {
  color: var(--color-text);
}

.modal-body {
  padding: var(--spacing-lg);
}

.form-group {
  margin-bottom: var(--spacing-lg);
}

.form-group label {
  display: block;
  margin-bottom: var(--spacing-xs);
  font-weight: 500;
  color: var(--color-text);
}

.form-input {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-md);
  font-family: inherit;
}

.form-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(33, 150, 243, 0.1);
}

.color-picker {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.color-input {
  width: 60px;
  height: 40px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.color-text {
  flex: 1;
}

.help-text {
  display: block;
  margin-top: var(--spacing-xs);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border);
}

.btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-md);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-primary {
  background-color: var(--color-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background-color: #1976d2;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background-color: #e0e0e0;
  color: var(--color-text);
}

.btn-secondary:hover {
  background-color: #d0d0d0;
}
</style>
