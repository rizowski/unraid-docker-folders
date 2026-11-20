import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useStackRemoveConfirm } from '../useStackRemoveConfirm';
import { useComposeStore } from '@/stores/compose';

describe('useStackRemoveConfirm', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useComposeStore().removeStack = vi.fn(async () => null);
  });

  it('always asks first and removes nothing until confirmed', () => {
    const { pending, request } = useStackRemoveConfirm();
    request('Immich');
    expect(pending.value).toEqual({ project: 'Immich' });
    expect(useComposeStore().removeStack).not.toHaveBeenCalled();
  });

  it('removes without deleting files when the box stays unticked', () => {
    const { pending, request, confirm } = useStackRemoveConfirm();
    request('Immich');
    confirm(false);
    expect(useComposeStore().removeStack).toHaveBeenCalledWith('Immich', false);
    expect(pending.value).toBeNull();
  });

  it('deletes files only when the box was ticked', () => {
    const { request, confirm } = useStackRemoveConfirm();
    request('Immich');
    confirm(true);
    expect(useComposeStore().removeStack).toHaveBeenCalledWith('Immich', true);
  });

  it('does nothing on cancel', () => {
    const { pending, request, cancel } = useStackRemoveConfirm();
    request('Immich');
    cancel();
    expect(pending.value).toBeNull();
    expect(useComposeStore().removeStack).not.toHaveBeenCalled();
  });
});
