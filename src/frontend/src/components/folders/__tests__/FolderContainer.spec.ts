import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FolderContainer from '../FolderContainer.vue';
import type { Folder } from '@/types/folder';

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 1,
    name: 'Test Folder',
    icon: null,
    color: '#ff8c2f',
    position: 0,
    collapsed: false,
    compose_project: null,
    created_at: 0,
    updated_at: 0,
    containers: [],
    ...overrides,
  };
}

describe('FolderContainer z-index stacking', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('FolderHeader root has relative positioning', () => {
    const wrapper = mount(FolderContainer, {
      props: { folder: makeFolder() },
      global: { plugins: [createPinia()] },
    });
    const header = wrapper.find('.relative');
    expect(header.exists()).toBe(true);
  });

  it('folder-content-grid exists as sibling after header', () => {
    const wrapper = mount(FolderContainer, {
      props: { folder: makeFolder() },
      global: { plugins: [createPinia()] },
    });
    const grid = wrapper.find('.folder-content-grid');
    expect(grid.exists()).toBe(true);
  });

  it('header dynamically elevates z-index when its menu opens', async () => {
    const wrapper = mount(FolderContainer, {
      props: { folder: makeFolder() },
      global: { plugins: [createPinia()] },
    });

    // Header should not have z-50 initially
    expect(wrapper.find('.z-50').exists()).toBe(false);

    // Open the folder kebab menu
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    // Now the header root should have z-50
    const elevated = wrapper.find('.z-50');
    expect(elevated.exists()).toBe(true);
  });
});
