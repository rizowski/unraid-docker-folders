import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useComposeStore } from '../compose';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

const reply = (ok: boolean, body: Record<string, unknown>, status = ok ? 200 : 500) =>
  ({ ok, status, json: async () => body }) as Response;

const REMOVED = {
  success: true,
  schedules_removed: 1,
  folder: 'deleted',
  files_removed: [],
  directory_removed: false,
  files_note: null,
};

describe('compose store – removeStack', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('posts the remove action with delete_files off by default choice and shows progress', async () => {
    mockApiFetch.mockResolvedValue(reply(true, REMOVED));
    const store = useComposeStore();

    const run = store.removeStack('Immich', false);
    expect(store.stackActionStatus.get('Immich')).toEqual({ kind: 'remove' });
    expect(store.isStackBusy('Immich')).toBe(true);
    const result = await run;

    const [url, options] = mockApiFetch.mock.calls[0];
    expect(url).toBe('/plugins/unraid-docker-folders-modern/api/compose.php?project=Immich&action=remove');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({ delete_files: false });
    expect(result?.schedules_removed).toBe(1);
    expect(store.stackActionStatus.has('Immich')).toBe(false);
  });

  it('sends delete_files when the user ticked the box', async () => {
    mockApiFetch.mockResolvedValue(reply(true, REMOVED));
    await useComposeStore().removeStack('Immich', true);
    expect(JSON.parse(String(mockApiFetch.mock.calls[0][1]?.body))).toEqual({ delete_files: true });
  });

  it('refreshes stacks, containers and folders after it worked', async () => {
    mockApiFetch.mockResolvedValue(reply(true, REMOVED));
    await useComposeStore().removeStack('Immich', false);
    const urls = mockApiFetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes('compose.php?action=list'))).toBe(true);
    expect(urls.some((u) => u.includes('containers.php'))).toBe(true);
    expect(urls.some((u) => u.includes('folders.php'))).toBe(true);
  });

  it('keeps the refusal on the row when containers still exist', async () => {
    const message = 'Containers of "Immich" still exist. Run Stack Down first, or the stack comes back on the next refresh.';
    mockApiFetch.mockResolvedValue(reply(false, { error: true, message }, 409));
    const store = useComposeStore();

    const result = await store.removeStack('Immich', true);

    expect(result).toBeNull();
    expect(store.stackActionStatus.get('Immich')).toEqual({ kind: 'remove', error: message });
    expect(store.isStackBusy('Immich')).toBe(false);
  });

  it('does not start a second removal while one runs', async () => {
    mockApiFetch.mockResolvedValue(reply(true, REMOVED));
    const store = useComposeStore();
    const first = store.removeStack('Immich', false);
    expect(await store.removeStack('Immich', true)).toBeNull();
    await first;
    expect(mockApiFetch.mock.calls.filter(([url]) => String(url).includes('action=remove'))).toHaveLength(1);
  });
});
