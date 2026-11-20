import { ref } from 'vue';
import { useComposeStore } from '@/stores/compose';

/**
 * Removing a stack from the plugin always asks first: it deletes the stack's
 * record, its schedules and its folder. File deletion is a checkbox in the
 * dialog and starts off, so a plain confirm touches no file.
 *
 * Bind `pending`, `confirm` and `cancel` to StackRemoveConfirmModal, mounted
 * with `v-if="pending"`, and call `request` from the stack's menu.
 */
export function useStackRemoveConfirm() {
  const composeStore = useComposeStore();
  const pending = ref<{ project: string } | null>(null);

  function request(project: string) {
    pending.value = { project };
  }

  function confirm(deleteFiles: boolean) {
    const project = pending.value?.project;
    pending.value = null;
    if (project === undefined) return;
    void composeStore.removeStack(project, deleteFiles);
  }

  function cancel() {
    pending.value = null;
  }

  return { pending, request, confirm, cancel };
}
