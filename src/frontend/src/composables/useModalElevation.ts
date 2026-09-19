import { computed, onScopeDispose, reactive, watch, type Ref } from 'vue';

/** Frame height each open modal needs, keyed per BaseModal instance. */
const floors = reactive(new Map<symbol, number>());

/**
 * The height the iframe must keep while modals are open, or 0 when none are.
 * main.ts feeds it to reportHeightToParent as the frame's minimum height.
 */
export const modalFrameFloor = computed(() => Math.max(0, ...floors.values()));

/**
 * While a modal is open inside the iframe, hold the frame at least
 * `requiredHeight()` tall so the modal isn't clipped at the frame's bottom.
 *
 * The frame is otherwise sized to the app's content. When that content is short
 * (a search filter, few folders) and the legacy Docker table sits below the
 * frame, a modal centred in the visible viewport would run past the frame and
 * its lower half, including the action buttons, could not be reached.
 */
export function useModalElevation(
  isOpen: Ref<boolean> | (() => boolean),
  requiredHeight: () => number
) {
  if (window.parent === window) return;

  const key = Symbol('modal');
  watch(
    [isOpen, requiredHeight],
    ([open, height]) => {
      if (open) floors.set(key, height);
      else floors.delete(key);
    },
    { immediate: true }
  );
  onScopeDispose(() => floors.delete(key));
}
