import { ref, watch, onMounted, onUnmounted, type WatchSource } from 'vue';

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

  const appEl = document.getElementById('app');

  function applyMinHeight() {
    if (appEl) {
      appEl.style.minHeight = (visibleTop.value + visibleHeight.value) + 'px';
    }
  }

  function clearMinHeight() {
    if (appEl) {
      appEl.style.minHeight = '';
    }
  }

  /**
   * Keep #app min-height in sync with the viewport while `isOpen` is true,
   * so the iframe grows tall enough for an absolutely-positioned overlay.
   * Cleans up on close and on component unmount.
   */
  function useViewportFitWhileOpen(isOpen: WatchSource<boolean>) {
    watch([isOpen, visibleTop, visibleHeight], ([open]) => {
      if (open) {
        applyMinHeight();
      } else {
        clearMinHeight();
      }
    });
    onUnmounted(() => clearMinHeight());
  }

  return { visibleTop, visibleHeight, useViewportFitWhileOpen };
}
