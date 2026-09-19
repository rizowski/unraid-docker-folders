/**
 * Scrolls the parent page while a container or folder is dragged near its edge.
 *
 * On Unraid the app runs in an iframe with scrolling="no" that is sized to its
 * full content height (see useParentViewport), so the parent page scrolls, not
 * the iframe. SortableJS only scrolls elements in its own document and cannot
 * reach the parent, so without this a drag cannot move past the visible part of
 * the page.
 *
 * Outside an iframe this does nothing: SortableJS already scrolls the window.
 */

/** Distance from the visible edge, in px, where scrolling starts. */
export const EDGE_ZONE = 60;
/** Scroll step per frame at the very edge, in px. */
export const MAX_STEP = 20;

export function useDragAutoScroll(win: Window = window) {
  const inIframe = win.parent !== win;

  // Pointer position in parent viewport coordinates. The pointer does not move
  // on screen while the page scrolls under it, so this stays valid between
  // events.
  let pointerY: number | null = null;
  let rafId = 0;
  let active = false;

  function frame(): HTMLElement | null {
    try {
      return win.frameElement as HTMLElement | null;
    } catch {
      return null; // cross-origin parent
    }
  }

  function onMove(e: DragEvent | PointerEvent | TouchEvent) {
    const iframe = frame();
    if (!iframe) return;
    const clientY = 'touches' in e ? e.touches[0]?.clientY : e.clientY;
    if (clientY === undefined) return;
    pointerY = iframe.getBoundingClientRect().top + clientY;
  }

  /** Scroll step for the current pointer: negative scrolls up, 0 stays put. */
  function step(): number {
    const iframe = frame();
    if (!iframe || pointerY === null) return 0;
    const rect = iframe.getBoundingClientRect();
    // Only the part of the iframe that is on screen counts as the edge.
    const top = Math.max(0, rect.top);
    const bottom = Math.min(win.parent.innerHeight, rect.bottom);

    if (pointerY < top + EDGE_ZONE) {
      const depth = Math.min(1, (top + EDGE_ZONE - pointerY) / EDGE_ZONE);
      return -Math.ceil(depth * MAX_STEP);
    }
    if (pointerY > bottom - EDGE_ZONE) {
      const depth = Math.min(1, (pointerY - (bottom - EDGE_ZONE)) / EDGE_ZONE);
      return Math.ceil(depth * MAX_STEP);
    }
    return 0;
  }

  function tick() {
    if (!active) return;
    const dy = step();
    if (dy !== 0) win.parent.scrollBy(0, dy);
    rafId = win.requestAnimationFrame(tick);
  }

  function start() {
    if (!inIframe || active) return;
    active = true;
    pointerY = null;
    // SortableJS uses native drag and drop on desktop, which fires dragover but
    // no pointer events. Pointer and touch events cover its fallback mode.
    win.document.addEventListener('dragover', onMove);
    win.document.addEventListener('pointermove', onMove);
    win.document.addEventListener('touchmove', onMove, { passive: true });
    rafId = win.requestAnimationFrame(tick);
  }

  function stop() {
    if (!active) return;
    active = false;
    pointerY = null;
    win.cancelAnimationFrame(rafId);
    win.document.removeEventListener('dragover', onMove);
    win.document.removeEventListener('pointermove', onMove);
    win.document.removeEventListener('touchmove', onMove);
  }

  return { start, stop };
}
