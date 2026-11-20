<template>
  <ConfirmModal
    is-open
    title="Remove Stack"
    :message="message"
    confirm-label="Remove Stack"
    variant="danger"
    :checkbox-label="ownFiles ? 'Also delete the compose files Docker Folders keeps for this stack' : undefined"
    @confirm="emit('confirm', $event)"
    @cancel="emit('cancel')"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import { useComposeStore } from '@/stores/compose';
import { useDockerStore } from '@/stores/docker';

// Mounted only while a removal is pending (see useStackRemoveConfirm). The
// checkbox is the delete-files choice and starts unchecked; ConfirmModal
// hands its state to `confirm`.
const props = defineProps<{
  project: string;
}>();

const emit = defineEmits<{
  confirm: [deleteFiles: boolean];
  cancel: [];
}>();

const composeStore = useComposeStore();
const dockerStore = useDockerStore();

// The backend says whether the files are in the plugin's own stack folder.
// For any other stack there is no box, and no file is ever deleted.
const ownFiles = computed(() => composeStore.stacks.find((s) => s.project_name === props.project)?.own_files === true);
const hasContainers = computed(() => (dockerStore.containersByProject.get(props.project)?.length ?? 0) > 0);

const message = computed(() => {
  const base = `Remove "${props.project}" from Docker Folders? Its schedules and its folder are removed too. Containers and compose files are not changed.`;
  return hasContainers.value ? `${base} This stack still has containers. Run Stack Down first.` : base;
});
</script>
