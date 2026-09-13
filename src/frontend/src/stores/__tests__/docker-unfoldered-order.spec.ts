import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDockerStore } from '../docker';
import { useFolderStore } from '../folders';
import { useSettingsStore } from '../settings';
import { makeContainer, makeFolder } from '@/test/fixtures';

// Mock apiFetch so instantiating the stores never makes real HTTP requests.
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

function names(store: ReturnType<typeof useDockerStore>): string[] {
  return store.unfolderedContainers.map((c) => c.name);
}

describe('docker store – unfolderedContainers with a saved order', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('falls back to state-first order when no order is saved', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer({ id: 'c', name: 'created', state: 'created' }),
      makeContainer({ id: 'r', name: 'running', state: 'running' }),
      makeContainer({ id: 'e', name: 'exited', state: 'exited' }),
    ];

    expect(names(store)).toEqual(['exited', 'running', 'created']);
  });

  it('applies the saved order regardless of container state', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'c', name: 'created', state: 'created' }),
      makeContainer({ id: 'r', name: 'running', state: 'running' }),
      makeContainer({ id: 'e', name: 'exited', state: 'exited' }),
    ];
    folderStore.unfolderedOrder = ['created', 'running', 'exited'];

    expect(names(store)).toEqual(['created', 'running', 'exited']);
  });

  it('lists unranked containers after the ranked ones, in state order', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'beta', state: 'created' }),
      makeContainer({ id: 'g', name: 'gamma', state: 'exited' }),
      makeContainer({ id: 'd', name: 'delta', state: 'running' }),
    ];
    folderStore.unfolderedOrder = ['delta', 'beta'];

    // delta and beta take the saved order; gamma (exited) precedes alpha (running).
    expect(names(store)).toEqual(['delta', 'beta', 'gamma', 'alpha']);
  });

  it('ignores names in the saved order that match no container', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'beta', state: 'running' }),
    ];
    folderStore.unfolderedOrder = ['ghost', 'beta', 'phantom', 'alpha'];

    expect(names(store)).toEqual(['beta', 'alpha']);
  });

  it('excludes a folder member even when it is ranked', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    store.containers = [
      makeContainer({ id: 'p', name: 'plex', state: 'running' }),
      makeContainer({ id: 'a', name: 'alpha', state: 'running' }),
      makeContainer({ id: 'b', name: 'beta', state: 'running' }),
    ];
    folderStore.folders = [makeFolder(['plex'])];
    folderStore.unfolderedOrder = ['plex', 'beta', 'alpha'];

    expect(names(store)).toEqual(['beta', 'alpha']);
  });

  it('uses the global sort mode instead of the saved order when it is not manual', () => {
    const store = useDockerStore();
    const folderStore = useFolderStore();
    const settingsStore = useSettingsStore();
    store.containers = [
      makeContainer({ id: 'c', name: 'charlie', state: 'running' }),
      makeContainer({ id: 'a', name: 'alpha', state: 'exited' }),
      makeContainer({ id: 'b', name: 'bravo', state: 'running' }),
    ];
    folderStore.unfolderedOrder = ['charlie', 'bravo', 'alpha'];

    settingsStore.sortMode = 'name-asc';
    expect(names(store)).toEqual(['alpha', 'bravo', 'charlie']);

    settingsStore.sortMode = 'manual';
    expect(names(store)).toEqual(['charlie', 'bravo', 'alpha']);
  });
});
