import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../folders';
import { makeFolder } from '@/test/fixtures';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

/** A promise the test resolves by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('folders store – toggleFolderCollapse', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('keeps the local value when a refetch lands before the collapse write', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'], { id: 1 }), makeFolder(['nginx'], { id: 2 })];

    const put = deferred<Response>();
    mockApiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'PUT') return put.promise;
      // The server has not stored the collapse yet.
      return {
        ok: true,
        json: async () => ({ folders: [makeFolder(['plex'], { id: 1 }), makeFolder(['nginx'], { id: 2 })] }),
      } as Response;
    });

    store.toggleFolderCollapse(1);
    await store.fetchFolders(true);

    expect(store.folders.map((f) => f.collapsed)).toEqual([true, false]);

    put.resolve({ ok: true } as Response);
    await new Promise((r) => setTimeout(r, 0));

    // Once the write ends, the server value is trusted again. Here another tab
    // expanded the folder.
    await store.fetchFolders(true);
    expect(store.folders.map((f) => f.collapsed)).toEqual([false, false]);
  });

  it('restores the old value when the collapse write fails', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'], { id: 1 })];
    mockApiFetch.mockImplementation(async () => ({ ok: false, status: 403 }) as Response);

    store.toggleFolderCollapse(1);
    expect(store.folders[0].collapsed).toBe(true);

    await vi.waitFor(() => expect(store.folders[0].collapsed).toBe(false));
  });

  it('keeps a newer click when an older write fails', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'], { id: 1 })];

    const first = deferred<Response>();
    mockApiFetch.mockImplementationOnce(async () => first.promise);
    mockApiFetch.mockImplementationOnce(async () => ({ ok: true }) as Response);

    store.toggleFolderCollapse(1); // collapse, held in flight
    store.toggleFolderCollapse(1); // expand again
    first.resolve({ ok: false, status: 500 } as Response);
    await new Promise((r) => setTimeout(r, 0));

    expect(store.folders[0].collapsed).toBe(false);
  });
});
