import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FolderHeader from '../FolderHeader.vue';
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

function mountHeader(folder?: Partial<Folder>) {
  return mount(FolderHeader, {
    props: { folder: makeFolder(folder) },
    global: {
      plugins: [createPinia()],
    },
  });
}

describe('FolderHeader', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('menu is hidden by default', () => {
    const wrapper = mountHeader();
    // The dropdown menu should not be rendered
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('clicking kebab button opens the menu', async () => {
    const wrapper = mountHeader();
    // Find the kebab button (the one inside the .relative menu wrapper)
    const menuWrapper = wrapper.find('[ref="menuRef"]');
    const kebabButton = menuWrapper.exists()
      ? menuWrapper.find('button')
      : wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions');
    expect(kebabButton).toBeTruthy();
    await kebabButton!.trigger('click');
    // Now menu items should be visible
    expect(wrapper.findAll('.kebab-menu-item').length).toBeGreaterThanOrEqual(2);
  });

  it('menu contains Edit and Delete buttons', async () => {
    const wrapper = mountHeader();
    // Open the menu
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    const items = wrapper.findAll('.kebab-menu-item');
    const labels = items.map((el) => el.text().trim());
    expect(labels).toContain('Edit');
    expect(labels).toContain('Delete');
  });

  it('clicking Edit emits edit event and closes menu', async () => {
    const wrapper = mountHeader();
    // Open menu
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    const editBtn = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Edit')!;
    await editBtn.trigger('click');

    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')!.length).toBe(1);
    // Menu should be closed
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('clicking Delete emits delete event and closes menu', async () => {
    const wrapper = mountHeader();
    // Open menu
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    const deleteBtn = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Delete')!;
    await deleteBtn.trigger('click');

    expect(wrapper.emitted('delete')).toBeTruthy();
    expect(wrapper.emitted('delete')!.length).toBe(1);
    // Menu should be closed
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  describe('z-index stacking', () => {
    it('root element has relative positioning for stacking context', () => {
      const wrapper = mountHeader();
      const root = wrapper.element as HTMLElement;
      expect(root.className).toContain('relative');
    });

    it('root does not have z-50 when menu is closed', () => {
      const wrapper = mountHeader();
      const root = wrapper.element as HTMLElement;
      expect(root.classList.contains('z-50')).toBe(false);
    });

    it('root gains z-50 when menu is open to elevate above sibling content', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');
      const root = wrapper.element as HTMLElement;
      expect(root.classList.contains('z-50')).toBe(true);
    });

    it('root loses z-50 when menu closes', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');
      expect((wrapper.element as HTMLElement).classList.contains('z-50')).toBe(true);

      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wrapper.vm.$nextTick();
      expect((wrapper.element as HTMLElement).classList.contains('z-50')).toBe(false);
    });

    it('dropdown menu has z-[100] within the header stacking context', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');

      const dropdown = wrapper.findAll('div').find((d) => d.classes().includes('absolute'));
      expect(dropdown).toBeTruthy();
      expect(dropdown!.element.className).toContain('z-[100]');
    });
  });

  it('click outside closes the menu', async () => {
    const wrapper = mountHeader();
    // Open menu
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');
    expect(wrapper.findAll('.kebab-menu-item').length).toBeGreaterThanOrEqual(1);

    // Simulate a click outside by dispatching on document
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });
});
