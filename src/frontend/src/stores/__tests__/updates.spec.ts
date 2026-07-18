import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useUpdatesStore, type ImageUpdateStatus } from '../updates';

// Mock apiFetch so no real HTTP requests are made
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

function status(image: string, updateAvailable: boolean): ImageUpdateStatus {
  return {
    image,
    local_digest: `${image}@sha256:local`,
    remote_digest: updateAvailable ? 'sha256:remote' : 'sha256:local',
    update_available: updateAvailable,
    checked_at: 1700000000,
    error: null,
    source_url: null,
  };
}

function okResponse(updates: Record<string, ImageUpdateStatus>): Response {
  return {
    ok: true,
    json: async () => ({ updates }),
  } as Response;
}

describe('updates store – targeted checks', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('checkImagesForUpdates merges results without discarding other entries', async () => {
    const store = useUpdatesStore();
    store.updates = {
      'nginx:latest': status('nginx:latest', true),
      'redis:7': status('redis:7', false),
    };
    mockApiFetch.mockResolvedValueOnce(okResponse({ 'redis:7': status('redis:7', true) }));

    await store.checkImagesForUpdates(['redis:7']);

    // redis updated in place, nginx untouched
    expect(store.updates['redis:7'].update_available).toBe(true);
    expect(store.updates['nginx:latest']).toBeDefined();
    expect(store.updates['nginx:latest'].update_available).toBe(true);
  });

  it('checkImagesForUpdates POSTs deduplicated image list as payload', async () => {
    const store = useUpdatesStore();
    mockApiFetch.mockResolvedValueOnce(okResponse({}));

    await store.checkImagesForUpdates(['nginx:latest', 'nginx:latest', '', 'redis:7']);

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockApiFetch.mock.calls[0];
    expect(url).toContain('updates.php?action=check');
    expect(JSON.parse(options!.body as string)).toEqual({ images: ['nginx:latest', 'redis:7'] });
  });

  it('checkImagesForUpdates does nothing for an empty list', async () => {
    const store = useUpdatesStore();

    await store.checkImagesForUpdates([]);
    await store.checkImagesForUpdates(['']);

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('tracks in-flight images via isCheckingImage and clears them after', async () => {
    const store = useUpdatesStore();
    let resolveFetch!: (r: Response) => void;
    mockApiFetch.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveFetch = resolve)));

    const promise = store.checkImagesForUpdates(['nginx:latest']);
    expect(store.isCheckingImage('nginx:latest')).toBe(true);
    expect(store.isCheckingImage('redis:7')).toBe(false);

    resolveFetch(okResponse({ 'nginx:latest': status('nginx:latest', false) }));
    await promise;

    expect(store.isCheckingImage('nginx:latest')).toBe(false);
    expect(store.checkingImages).toEqual([]);
  });

  it('clears in-flight images even when the request fails', async () => {
    const store = useUpdatesStore();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApiFetch.mockRejectedValueOnce(new Error('network down'));

    await store.checkImagesForUpdates(['nginx:latest']);

    expect(store.isCheckingImage('nginx:latest')).toBe(false);
    consoleSpy.mockRestore();
  });

  it('checkForUpdates (full check) still replaces the whole cache', async () => {
    const store = useUpdatesStore();
    store.updates = { 'ghost:5': status('ghost:5', true) };
    mockApiFetch.mockResolvedValueOnce(okResponse({ 'nginx:latest': status('nginx:latest', false) }));

    await store.checkForUpdates();

    expect(store.updates['ghost:5']).toBeUndefined();
    expect(store.updates['nginx:latest']).toBeDefined();
  });
});
