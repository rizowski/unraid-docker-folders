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

describe('folder store – sortedFolders', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useDockerStore().containers = [
      makeContainer({ id: 'old-up', name: 'old-up', state: 'running', created: 100 }),
      makeContainer({ id: 'new-down', name: 'new-down', state: 'exited', created: 900 }),
    ];
    // Drag order puts the stopped, newer folder first.
    useFolderStore().folders = [
      makeFolder(['new-down'], { id: 1, name: 'Stopped', position: 0 }),
      makeFolder(['old-up'], { id: 2, name: 'Running', position: 1 }),
    ];
  });

  const names = () => useFolderStore().sortedFolders.map((f) => f.name);

  it('keeps the drag order under an automatic mode when sort folders is off', () => {
    useSettingsStore().sortMode = 'status';
    expect(names()).toEqual(['Stopped', 'Running']);
  });

  it('ranks folders by their most active container under status when sort folders is on', () => {
    const settings = useSettingsStore();
    settings.sortMode = 'status';
    settings.sortFolders = true;
    expect(names()).toEqual(['Running', 'Stopped']);
  });

  it('ranks folders by their newest container under oldest first when sort folders is on', () => {
    const settings = useSettingsStore();
    settings.sortMode = 'created-asc';
    settings.sortFolders = true;
    expect(names()).toEqual(['Running', 'Stopped']);
  });
});
