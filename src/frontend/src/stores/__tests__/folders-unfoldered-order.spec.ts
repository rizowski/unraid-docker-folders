import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../folders';
import { makeFolder } from '@/test/fixtures';

// Mock apiFetch so no real HTTP requests are made
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

function okResponse(payload: Record<string, unknown>): Response {
  return { ok: true, json: async () => payload } as Response;
}

describe('folders store – unfoldered order', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  describe('fetchFolders', () => {
    it('stores unfoldered_order from the payload', async () => {
      mockApiFetch.mockResolvedValue(
        okResponse({ folders: [makeFolder(['plex'])], count: 1, unfoldered_order: ['beta', 'alpha'] }),
      );
      const store = useFolderStore();

      await store.fetchFolders();

      expect(store.folders).toHaveLength(1);
      expect(store.unfolderedOrder).toEqual(['beta', 'alpha']);
    });

    it('resets unfolderedOrder to [] when the payload has none', async () => {
      const store = useFolderStore();
      store.unfolderedOrder = ['stale'];
      mockApiFetch.mockResolvedValue(okResponse({ folders: [], count: 0 }));

      await store.fetchFolders(true);

      expect(store.unfolderedOrder).toEqual([]);
    });
  });

  describe('reorderUnfoldered', () => {
    it('posts the names to reorder_unfoldered and stores the response order', async () => {
      mockApiFetch.mockResolvedValue(okResponse({ success: true, unfoldered_order: ['b', 'a', 'c'] }));
      const store = useFolderStore();

      const ok = await store.reorderUnfoldered(['b', 'a', 'c']);

      expect(ok).toBe(true);
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockApiFetch.mock.calls[0];
      expect(String(url)).toBe('/plugins/unraid-docker-folders-modern/api/folders.php?action=reorder_unfoldered');
      expect(options?.method).toBe('POST');
      expect(JSON.parse(String(options?.body))).toEqual({ container_names: ['b', 'a', 'c'] });
      expect(store.unfolderedOrder).toEqual(['b', 'a', 'c']);
    });

    it('falls back to the sent list when the response carries no order', async () => {
      mockApiFetch.mockResolvedValue(okResponse({ success: true }));
      const store = useFolderStore();

      await store.reorderUnfoldered(['x', 'y']);

      expect(store.unfolderedOrder).toEqual(['x', 'y']);
    });

    it('returns false and leaves state alone on a non-ok response', async () => {
      mockApiFetch.mockResolvedValue({ ok: false, status: 500 } as Response);
      const store = useFolderStore();
      store.unfolderedOrder = ['keep', 'me'];

      const ok = await store.reorderUnfoldered(['me', 'keep']);

      expect(ok).toBe(false);
      expect(store.unfolderedOrder).toEqual(['keep', 'me']);
    });
  });
});
