import { watch, type Ref } from 'vue';

/**
 * When a modal opens inside the iframe, tells the parent page to elevate
 * the iframe's z-index so the modal isn't hidden behind sibling elements
 * (e.g. Unraid's container list, bottom nav bar).
 */
export function useModalElevation(isOpen: Ref<boolean> | (() => boolean)) {
  const inIframe = window.parent !== window;
  if (!inIframe) return;

  watch(isOpen, (open) => {
    window.parent.postMessage(
      { type: 'docker-folders-modal', open },
      '*'
    );
  });
}
