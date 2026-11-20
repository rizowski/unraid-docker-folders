<template>
  <ConfirmModal
    is-open
    title="Remove Stack"
    :message="message"
    confirm-label="Remove Stack"
    variant="danger"
    checkbox-label="Also delete the files in the plugin's own stack folder"
    @confirm="emit('confirm', $event)"
    @cancel="emit('cancel')"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ConfirmModal from '@/components/ConfirmModal.vue';

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

// Says what goes and what stays. No container is touched: the backend refuses
// while the stack has containers, and the stack's own folder goes with it.
const message = computed(
  () =>
    `Remove "${props.project}" from Docker Folders? Its record, its schedules and its folder are deleted. Containers are never touched, so a stack with containers must be taken down first. Compose files stay on disk unless you tick the box, and then only a copy that Docker Folders keeps itself is deleted, never files in another folder and never while a container still runs from that copy.`,
);
</script>
