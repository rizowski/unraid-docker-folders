import { watch, type Ref } from 'vue';

/**
 * When a modal opens inside the iframe, tells the parent page to:
 * 1. Elevate the iframe's z-index above sibling elements
 * 2. Expand the iframe height so the modal isn't clipped at the bottom
 * 3. Lock parent page scrolling
 */
export function useModalElevation(isOpen: Ref<boolean> | (() => boolean)) {
  const inIframe = window.parent !== window;
  if (!inIframe) return;

  watch(isOpen, (open) => {
    let minHeight = 0;
    if (open) {
      try {
        const iframe = window.frameElement as HTMLIFrameElement | null;
        if (iframe) {
          const rect = iframe.getBoundingClientRect();
          const visibleTop = Math.max(0, -rect.top);
          const visibleHeight = window.parent.innerHeight;
          minHeight = visibleTop + visibleHeight;
        }
      } catch {
        // Cross-origin: can't calculate, parent will use defaults
      }
    }
    window.parent.postMessage(
      { type: 'docker-folders-modal', open, minHeight },
      '*'
    );
  });
}
