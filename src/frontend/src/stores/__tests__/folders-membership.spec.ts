import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFolderStore } from '../folders';
import type { Folder, ContainerAssociation } from '@/types/folder';

// Mock apiFetch so no real HTTP requests are made
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

function assoc(name: string, position: number): ContainerAssociation {
  return {
    id: position + 1,
    container_id: `id-${name}`,
    container_name: name,
    folder_id: 1,
    position,
  };
}

function makeFolder(containerNames: string[], overrides: Partial<Folder> = {}): Folder {
  return {
    id: 1,
    name: 'Media',
    icon: null,
    color: '#ff8c2f',
    position: 0,
    collapsed: false,
    compose_project: null,
    created_at: 0,
    updated_at: 0,
    containers: containerNames.map((n, i) => assoc(n, i)),
    ...overrides,
  };
}

/** Every mutation endpoint returns `{ folder }`; the store swaps it into state. */
function okResponse(folder: Folder): Response {
  return { ok: true, json: async () => ({ success: true, folder }) } as Response;
}

/** The URLs of every apiFetch call, in order. */
function calledUrls(): string[] {
  return mockApiFetch.mock.calls.map((c) => String(c[0]));
}

describe('folders store – setFolderContainers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async () => okResponse(makeFolder([])));
  });

  it('issues no requests when the desired set already matches the folder', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr', 'radarr'])];

    // Same members, deliberately in a different order.
    const ok = await store.setFolderContainers(1, [
      { id: 'id-radarr', name: 'radarr' },
      { id: 'id-plex', name: 'plex' },
      { id: 'id-sonarr', name: 'sonarr' },
    ]);

    expect(ok).toBe(true);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('adds only the new container, leaving existing members untouched', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-sonarr', name: 'sonarr' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);

    const adds = calledUrls().filter((u) => u.includes('action=add_container'));
    expect(adds).toHaveLength(1);

    const body = String(mockApiFetch.mock.calls[0][1]?.body);
    expect(JSON.parse(body)).toEqual({ container_id: 'id-bazarr', container_name: 'bazarr' });
  });

  it('removes a container that is no longer in the desired set', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, [{ id: 'id-plex', name: 'plex' }]);

    const removes = calledUrls().filter((u) => u.includes('action=remove_container'));
    expect(removes).toHaveLength(1);
    expect(calledUrls().some((u) => u.includes('action=add_container'))).toBe(false);
  });

  it('removes every member when the desired set is empty', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, []);

    const removes = calledUrls().filter((u) => u.includes('action=remove_container'));
    expect(removes).toHaveLength(2);
  });

  it('issues removals before additions', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'sonarr'])];

    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);

    const actions = calledUrls()
      .filter((u) => u.includes('action=add_container') || u.includes('action=remove_container'))
      .map((u) => (u.includes('remove_container') ? 'remove' : 'add'));

    expect(actions).toEqual(['remove', 'add']);
  });

  it('ignores a desired entry that is already a member but was not shown in the picker', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex', 'ghost'])];

    // 'ghost' is passed straight through from the folder's own associations
    // because Docker is not currently reporting it.
    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-ghost', name: 'ghost' },
    ]);

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('drops entries with an empty name so they cannot collide on UNIQUE(container_name)', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'])];

    await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'unresolved-a', name: '' },
      { id: 'unresolved-b', name: '' },
    ]);

    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('returns false and issues no requests for an unknown folder', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'])];

    const ok = await store.setFolderContainers(999, [{ id: 'id-x', name: 'x' }]);

    expect(ok).toBe(false);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('reports failure when an add fails', async () => {
    const store = useFolderStore();
    store.folders = [makeFolder(['plex'])];
    mockApiFetch.mockImplementation(async () => ({ ok: false }) as Response);

    const ok = await store.setFolderContainers(1, [
      { id: 'id-plex', name: 'plex' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);

    expect(ok).toBe(false);
  });
});
