<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="500px" @close="handleOverlayClick">
      <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border">
        <h2 class="text-2xl font-semibold">{{ isEditing ? 'Edit Folder' : 'Create Folder' }}</h2>
        <button class="flex items-center justify-center w-8 h-8 rounded-full border-none bg-transparent cursor-pointer text-text-secondary hover:text-text hover:bg-border transition" @click="$emit('close')" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <form @submit.prevent="handleSubmit" class="p-4 sm:p-6">
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
          <label class="block mb-1 font-medium text-text">Containers</label>
          <span class="block mb-2 text-sm text-text-secondary">Select which containers belong to this folder</span>
          <div class="max-h-[200px] overflow-auto border border-border rounded bg-bg">
            <label
              v-for="container in availableContainers"
              :key="container.id"
              class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-card transition-colors"
              :class="{ 'bg-bg-card': effectiveSelection.has(container.id) }"
            >
              <input
                type="checkbox"
                :checked="effectiveSelection.has(container.id)"
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
          <button type="button" @click="$emit('close')" class="nav-btn">Cancel</button>
          <button type="submit" class="nav-btn active" :class="{ 'opacity-50 cursor-not-allowed': !formData.name }" :disabled="!formData.name">{{ isEditing ? 'Save Changes' : 'Create Folder' }}</button>
        </div>
      </form>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import BaseModal from '@/components/BaseModal.vue';
import { useParentModal } from '@/composables/useParentModal';
import type { Folder, FolderCreateData, FolderUpdateData, FolderContainerSelection } from '@/types/folder';

interface Props {
  isOpen: boolean;
  folder?: Folder | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  // `null` means the container picker was never presented, so associations must
  // be left alone. An empty array means "remove every container".
  save: [data: FolderCreateData | FolderUpdateData, containers: FolderContainerSelection[] | null];
}>();

const dockerStore = useDockerStore();
const folderStore = useFolderStore();

const isEditing = computed(() => !!props.folder);

const formData = ref({
  name: '',
  color: '#ff8c2f',
});

// `null` = the user has not touched the list, so the selection is derived from
// the folder's current members. Seeding a Set up front would go stale: the watch
// below only fires on [isOpen, folder], so a docker list that arrives afterwards
// would leave every existing member rendered unchecked — which now reads as
// "remove them all".
const selectedContainerIds = ref<Set<string> | null>(null);

const existingNames = computed(
  () => new Set((props.folder?.containers ?? []).map((c) => c.container_name)),
);

const availableContainers = computed(() => {
  const assignedNames = new Set<string>();
  folderStore.folders.forEach((folder) => {
    // When editing, don't exclude containers already in this folder
    if (props.folder && folder.id === props.folder.id) return;
    folder.containers.forEach((assoc) => assignedNames.add(assoc.container_name));
  });
  const unassigned = dockerStore.sortedContainers.filter((c) => !assignedNames.has(c.name));

  if (!props.folder) return unassigned;

  // This folder's own containers first, in their stored order, so the list
  // mirrors the folder. folder.containers already arrives ordered by position.
  const memberOrder = new Map(props.folder.containers.map((c, i) => [c.container_name, i]));
  const members = unassigned
    .filter((c) => memberOrder.has(c.name))
    .sort((a, b) => memberOrder.get(a.name)! - memberOrder.get(b.name)!);

  return [...members, ...unassigned.filter((c) => !memberOrder.has(c.name))];
});

const effectiveSelection = computed<Set<string>>(
  () =>
    selectedContainerIds.value ??
    new Set(
      availableContainers.value.filter((c) => existingNames.value.has(c.name)).map((c) => c.id),
    ),
);

function toggleContainer(id: string) {
  // Seeds from the derived selection on first touch.
  const next = new Set(effectiveSelection.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedContainerIds.value = next;
}

/**
 * Turn the checked ids into the full desired membership set.
 *
 * Associations the picker could not show — a container temporarily missing from
 * Docker, e.g. mid-recreate — are passed through so that saving never silently
 * drops them. Their stored `container_id` may be stale, which is safe only
 * because a passed-through entry always matches an existing member by name and
 * so is never sent to add_container.
 */
function resolveDesired(checkedIds: string[]): FolderContainerSelection[] {
  const byId = new Set(checkedIds);
  const picked = availableContainers.value
    .filter((c) => byId.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  const shown = new Set(availableContainers.value.map((c) => c.name));
  const preserved = (props.folder?.containers ?? [])
    .filter((assoc) => !shown.has(assoc.container_name))
    .map((assoc) => ({ id: assoc.container_id, name: assoc.container_name }));

  return [...picked, ...preserved];
}

const parentModal = useParentModal({
  onAction({ actionId, values }) {
    if (actionId === 'save') {
      const name = typeof values.name === 'string' ? values.name.trim() : '';
      const color = typeof values.color === 'string' ? values.color : '#ff8c2f';
      if (!name) return;
      // Absent when the picker was never rendered — leave associations alone.
      const containers = Array.isArray(values.containers)
        ? resolveDesired(values.containers as string[])
        : null;
      emit('save', { name, color }, containers);
    } else {
      emit('close');
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  const initialName = props.folder?.name || '';
  const initialColor = props.folder?.color || '#ff8c2f';
  const existingContainerNames = new Set(
    (props.folder?.containers || []).map((c) => c.container_name),
  );

  parentModal.open({
    kind: 'folder-edit',
    title: isEditing.value ? 'Edit Folder' : 'Create Folder',
    size: 'md',
    fields: [
      {
        type: 'input',
        id: 'name',
        label: 'Folder Name *',
        value: initialName,
        placeholder: 'Enter folder name',
        required: true,
        autofocus: true,
      },
      {
        type: 'color',
        id: 'color',
        label: 'Color',
        value: initialColor,
        caption: "Choose a color for the folder's left border",
      },
      ...(availableContainers.value.length > 0
        ? [
            {
              type: 'checkbox-list' as const,
              id: 'containers',
              label: 'Containers',
              caption: 'Select which containers belong to this folder',
              items: availableContainers.value.map((c) => ({
                id: c.id,
                label: c.name,
                icon: c.icon || undefined,
                state: c.state,
                checked: existingContainerNames.has(c.name),
              })),
            },
          ]
        : []),
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'default' },
      {
        id: 'save',
        label: isEditing.value ? 'Save Changes' : 'Create Folder',
        variant: 'primary',
        disabledWhenEmpty: 'name',
      },
    ],
  });
}

// Reset form when modal opens/closes or folder changes
watch(
  () => [props.isOpen, props.folder],
  () => {
    selectedContainerIds.value = null;
    if (props.isOpen && props.folder) {
      formData.value = {
        name: props.folder.name,
        color: props.folder.color || '#ff8c2f',
      };
    } else if (props.isOpen) {
      formData.value = {
        name: '',
        color: '#ff8c2f',
      };
    }

    if (inIframe) {
      if (props.isOpen) openParent();
      else parentModal.close();
    }
  },
  { immediate: true },
);

function handleOverlayClick() {
  emit('close');
}

function handleSubmit() {
  emit(
    'save',
    formData.value,
    availableContainers.value.length > 0 ? resolveDesired([...effectiveSelection.value]) : null,
  );
}
</script>
