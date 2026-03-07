import { ref, onMounted, onUnmounted } from 'vue';

const SM_BREAKPOINT = 640;

/** Reactive flag that's true when viewport is below Tailwind's `sm` breakpoint (640px). */
export function useIsMobile() {
  const hasWindow = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const isMobile = ref(hasWindow ? window.innerWidth < SM_BREAKPOINT : false);
  let mql: MediaQueryList | null = null;

  function update(e: MediaQueryListEvent) {
    isMobile.value = !e.matches;
  }

  onMounted(() => {
    if (!hasWindow) return;
    mql = window.matchMedia(`(min-width: ${SM_BREAKPOINT}px)`);
    isMobile.value = !mql.matches;
    mql.addEventListener('change', update);
  });

  onUnmounted(() => {
    mql?.removeEventListener('change', update);
  });

  return isMobile;
}
