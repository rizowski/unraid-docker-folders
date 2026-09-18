import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { modalFrameFloor, useModalElevation } from '../useModalElevation';

describe('useModalElevation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'parent', { value: {}, configurable: true, writable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true });
  });

  it('holds the frame floor at the tallest open modal and clears it on close', async () => {
    const firstOpen = ref(false);
    const secondOpen = ref(false);
    const firstHeight = ref(900);
    const scope = effectScope();
    scope.run(() => {
      useModalElevation(firstOpen, () => firstHeight.value);
      useModalElevation(secondOpen, () => 700);
    });

    expect(modalFrameFloor.value).toBe(0);

    firstOpen.value = true;
    secondOpen.value = true;
    await nextTick();
    expect(modalFrameFloor.value).toBe(900);

    // The parent page scrolled, so the modal needs more room.
    firstHeight.value = 1200;
    await nextTick();
    expect(modalFrameFloor.value).toBe(1200);

    firstOpen.value = false;
    await nextTick();
    expect(modalFrameFloor.value).toBe(700);

    // Unmounting an open modal must not leave the frame stretched.
    scope.stop();
    expect(modalFrameFloor.value).toBe(0);
  });

  it('does nothing outside an iframe', async () => {
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true });
    const scope = effectScope();
    scope.run(() => useModalElevation(ref(true), () => 800));
    await nextTick();
    expect(modalFrameFloor.value).toBe(0);
    scope.stop();
  });
});
