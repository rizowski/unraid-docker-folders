<template>
  <div v-if="isOpen" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]" @click="handleOverlayClick">
    <div class="bg-bg-card rounded-lg shadow-lg max-w-[500px] w-[90%] max-h-[90vh] overflow-auto" @click.stop>
      <div class="flex justify-between items-center p-6 border-b border-border">
        <h2 class="text-2xl font-semibold">{{ isEditing ? 'Edit Folder' : 'Create Folder' }}</h2>
        <button class="flex items-center justify-center w-8 h-8 rounded-full border-none bg-transparent cursor-pointer text-text-secondary hover:text-text hover:bg-border transition" @click="$emit('close')" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
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

        <div v-if="availableContainers.length > 0" class="mb-6">
          <label class="block mb-1 font-medium text-text">Add Containers</label>
          <span class="block mb-2 text-sm text-text-secondary">Select unfoldered containers to add to this folder</span>
          <div class="max-h-[200px] overflow-auto border border-border rounded bg-bg">
            <label
              v-for="container in availableContainers"
              :key="container.id"
              class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-card transition-colors"
              :class="{ 'bg-bg-card': selectedContainerIds.has(container.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedContainerIds.has(container.id)"
                @change="toggleContainer(container.id)"
                class="shrink-0"
              />
              <img v-if="container.icon" :src="container.icon" :alt="container.name" class="w-5 h-5 object-contain shrink-0" />
              <span class="text-base text-text">{{ container.name }}</span>
              <span
                class="ml-auto px-2 py-0.5 rounded-full text-xs font-semibold uppercase"
                :class="container.state === 'running' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'"
              >{{ container.state }}</span>
            </label>
          </div>
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
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import type { Folder, FolderCreateData, FolderUpdateData } from '@/types/folder';

interface Props {
  isOpen: boolean;
  folder?: Folder | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  save: [data: FolderCreateData | FolderUpdateData, containerIds: string[]];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();

const isEditing = computed(() => !!props.folder);

const formData = ref({
  name: '',
  color: '#ff8c2f',
});

const selectedContainerIds = ref<Set<string>>(new Set());

const availableContainers = computed(() => {
  const assignedIds = new Set<string>();
  folderStore.folders.forEach((folder) => {
    // When editing, don't exclude containers already in this folder
    if (props.folder && folder.id === props.folder.id) return;
    folder.containers.forEach((assoc) => assignedIds.add(assoc.container_id));
  });
  return dockerStore.sortedContainers.filter((c) => !assignedIds.has(c.id));
});

function toggleContainer(id: string) {
  const next = new Set(selectedContainerIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedContainerIds.value = next;
}

// Reset form when modal opens/closes or folder changes
watch(
  () => [props.isOpen, props.folder],
  () => {
    selectedContainerIds.value = new Set();
    if (props.isOpen && props.folder) {
      // Editing existing folder
      formData.value = {
        name: props.folder.name,
        color: props.folder.color || '#ff8c2f',
      };
    } else if (props.isOpen) {
      // Creating new folder
      formData.value = {
        name: '',
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
  emit('save', formData.value, Array.from(selectedContainerIds.value));
}
</script>
