import { ref, watch, onMounted, onUnmounted, type WatchSource } from 'vue';

/**
 * Minimum iframe height floor, set by modals to prevent the ResizeObserver
 * from shrinking the iframe while an overlay is open. Exported so main.ts
 * can incorporate it into the height message sent to the parent frame.
 */
let _iframeMinHeight = 0;
export function getIframeMinHeight() {
  return _iframeMinHeight;
}

/**
 * Tracks the parent window's visible viewport area relative to this iframe.
 *
 * When the app runs inside an iframe with scrolling="no", the iframe is sized
 * to its full content height and the parent page scrolls. CSS `position: fixed`
 * is relative to the iframe viewport (= full content height), not the user's
 * visible viewport. This composable provides the visible top offset and height
 * so modals can be positioned in the user's actual viewport.
 *
 * Falls back to standard viewport values when not in an iframe.
 */
export function useParentViewport() {
  const visibleTop = ref(0);
  const visibleHeight = ref(window.innerHeight);

  const inIframe = window.parent !== window;

  function update() {
    if (!inIframe) {
      visibleTop.value = window.scrollY;
      visibleHeight.value = window.innerHeight;
      return;
    }

    try {
      // Try to read parent scroll position (same-origin only)
      const iframe = window.frameElement as HTMLIFrameElement | null;
      if (iframe) {
        const rect = iframe.getBoundingClientRect();
        // rect.top is the iframe's position relative to parent viewport
        // When scrolled, rect.top goes negative
        visibleTop.value = Math.max(0, -rect.top);
        visibleHeight.value = window.parent.innerHeight;
      }
    } catch {
      // Cross-origin: fall back to own viewport
      visibleTop.value = 0;
      visibleHeight.value = window.innerHeight;
    }
  }

  let target: Window;
  let rafId = 0;
  let ticking = false;

  function onScroll() {
    if (!ticking) {
      ticking = true;
      rafId = requestAnimationFrame(() => {
        update();
        ticking = false;
      });
    }
  }

  onMounted(() => {
    update();
    target = inIframe ? window.parent : window;
    try {
      target.addEventListener('scroll', onScroll, { passive: true });
      target.addEventListener('resize', onScroll, { passive: true });
    } catch {
      // Cross-origin fallback
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
    }
  });

  onUnmounted(() => {
    cancelAnimationFrame(rafId);
    try {
      target?.removeEventListener('scroll', onScroll);
      target?.removeEventListener('resize', onScroll);
    } catch {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    }
  });

  /**
   * Lock parent scroll and set a one-time iframe height floor while
   * `isOpen` is true. This prevents the feedback loop where growing the
   * iframe changes the scroll geometry which grows the iframe again.
   */
  function useViewportFitWhileOpen(isOpen: WatchSource<boolean>) {
    let savedOverflow = '';

    function lock() {
      // Lock parent page scroll to prevent background scrolling behind modal
      try {
        const parentBody = (inIframe ? window.parent : window).document.body;
        savedOverflow = parentBody.style.overflow;
        parentBody.style.overflow = 'hidden';
      } catch { /* cross-origin */ }

      // Set iframe height floor once and notify parent directly
      _iframeMinHeight = visibleTop.value + visibleHeight.value;
      if (inIframe) {
        const appEl = document.getElementById('app');
        const height = Math.max(appEl?.offsetHeight ?? 0, _iframeMinHeight);
        window.parent.postMessage({ type: 'docker-folders-resize', height }, '*');
      }
    }

    function unlock() {
      try {
        const parentBody = (inIframe ? window.parent : window).document.body;
        parentBody.style.overflow = savedOverflow;
      } catch { /* cross-origin */ }
      _iframeMinHeight = 0;
    }

    watch(isOpen, (open) => {
      if (open) lock(); else unlock();
    });

    onUnmounted(() => unlock());
  }

  return { visibleTop, visibleHeight, useViewportFitWhileOpen };
}
