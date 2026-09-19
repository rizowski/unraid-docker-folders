import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDragAutoScroll, MAX_STEP } from '../useDragAutoScroll';

/**
 * A fake iframe window. The iframe starts at `frameTop` in a parent viewport
 * 800px tall, and is 3000px tall, like the Folders tab on a long page.
 * Animation frames run only when the test calls `runFrame`.
 */
function fakeFrameWindow(frameTop = 0) {
  const doc = new EventTarget();
  const scrollBy = vi.fn();
  const frames: FrameRequestCallback[] = [];
  const iframe = {
    getBoundingClientRect: () => ({ top: frameTop, bottom: frameTop + 3000 }),
  };
  const win = {
    parent: { innerHeight: 800, scrollBy },
    frameElement: iframe,
    document: doc,
    requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
    cancelAnimationFrame: () => frames.splice(0),
  } as unknown as Window;

  function move(clientY: number) {
    const e = new Event('dragover') as Event & { clientY: number };
    e.clientY = clientY;
    doc.dispatchEvent(e);
  }

  function runFrame() {
    const pending = frames.splice(0);
    pending.forEach((cb) => cb(0));
  }

  return { win, scrollBy, move, runFrame, pendingFrames: () => frames.length };
}

describe('useDragAutoScroll', () => {
  let fake: ReturnType<typeof fakeFrameWindow>;

  beforeEach(() => {
    fake = fakeFrameWindow();
  });

  it('scrolls the parent down when the pointer is at the bottom edge', () => {
    const { start } = useDragAutoScroll(fake.win);
    start();
    fake.move(799);
    fake.runFrame();

    expect(fake.scrollBy).toHaveBeenCalledWith(0, MAX_STEP);
  });

  it('scrolls the parent up when the pointer is at the top edge', () => {
    const { start } = useDragAutoScroll(fake.win);
    start();
    fake.move(0);
    fake.runFrame();

    expect(fake.scrollBy).toHaveBeenCalledWith(0, -MAX_STEP);
  });

  it('scrolls slower when the pointer is only just inside the edge zone', () => {
    const { start } = useDragAutoScroll(fake.win);
    start();
    fake.move(760);
    fake.runFrame();

    const [, dy] = fake.scrollBy.mock.calls[0];
    expect(dy).toBeGreaterThan(0);
    expect(dy).toBeLessThan(MAX_STEP);
  });

  it('does not scroll when the pointer is in the middle', () => {
    const { start } = useDragAutoScroll(fake.win);
    start();
    fake.move(400);
    fake.runFrame();

    expect(fake.scrollBy).not.toHaveBeenCalled();
  });

  it('measures the top edge from where the iframe starts on screen', () => {
    // The iframe starts 200px down, below the Unraid header.
    fake = fakeFrameWindow(200);
    const { start } = useDragAutoScroll(fake.win);
    start();
    fake.move(10); // 210px in the parent viewport, in the edge zone
    fake.runFrame();

    expect(fake.scrollBy.mock.calls[0][1]).toBeLessThan(0);
  });

  it('stops scrolling and listening after stop()', () => {
    const { start, stop } = useDragAutoScroll(fake.win);
    start();
    fake.move(799);
    stop();
    fake.runFrame();
    fake.move(799);
    fake.runFrame();

    expect(fake.scrollBy).not.toHaveBeenCalled();
    expect(fake.pendingFrames()).toBe(0);
  });

  it('does nothing outside an iframe', () => {
    const raf = vi.fn();
    const win = { document: new EventTarget(), requestAnimationFrame: raf } as unknown as Window;
    Object.assign(win, { parent: win });

    useDragAutoScroll(win).start();

    expect(raf).not.toHaveBeenCalled();
  });
});
