import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import FolderHeader from '../FolderHeader.vue';
import { useDockerStore } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
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

// The component must share the pinia the test writes to. Installing a second
// `createPinia()` here would give the component its own stores, and any state
// a test set up would be invisible to it.
let pinia: Pinia;

function mountHeader(folder?: Partial<Folder>) {
  return mount(FolderHeader, {
    props: { folder: makeFolder(folder) },
    global: {
      plugins: [pinia],
    },
  });
}

describe('FolderHeader', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
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

  it('menu contains folder options and delete buttons', async () => {
    const wrapper = mountHeader();
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    const items = wrapper.findAll('.kebab-menu-item');
    const labels = items.map((el) => el.text().trim());
    expect(labels).toContain('Folder Options');
    expect(labels).toContain('Delete Folder');
  });

  it('clicking Folder Options emits edit event and closes menu', async () => {
    const wrapper = mountHeader();
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    const editBtn = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Folder Options')!;
    await editBtn.trigger('click');

    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')!.length).toBe(1);
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('clicking Delete Folder emits delete event and closes menu', async () => {
    const wrapper = mountHeader();
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
    await kebab.trigger('click');

    const deleteBtn = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Delete Folder')!;
    await deleteBtn.trigger('click');

    expect(wrapper.emitted('delete')).toBeTruthy();
    expect(wrapper.emitted('delete')!.length).toBe(1);
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  describe('z-index stacking', () => {
    // FolderHeader renders a fragment (header div + InputModal), so
    // wrapper.element is the mount container — target the header div itself.
    const headerRoot = (wrapper: ReturnType<typeof mountHeader>) =>
      wrapper.get('div.folder-header').element as HTMLElement;

    it('root element has relative positioning for stacking context', () => {
      const wrapper = mountHeader();
      expect(headerRoot(wrapper).className).toContain('relative');
    });

    it('root does not have z-50 when menu is closed', () => {
      const wrapper = mountHeader();
      expect(headerRoot(wrapper).classList.contains('z-50')).toBe(false);
    });

    it('root gains z-50 when menu is open to elevate above sibling content', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');
      expect(headerRoot(wrapper).classList.contains('z-50')).toBe(true);
    });

    it('root loses z-50 when menu closes', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');
      expect(headerRoot(wrapper).classList.contains('z-50')).toBe(true);

      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wrapper.vm.$nextTick();
      expect(headerRoot(wrapper).classList.contains('z-50')).toBe(false);
    });

    it('dropdown menu has z-[100] within the header stacking context', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');

      const dropdown = wrapper.findAll('div').find((d) => d.classes().includes('shadow-lg'));
      expect(dropdown).toBeTruthy();
      expect(dropdown!.element.className).toContain('z-[100]');
    });
  });

  describe('compose actions while the status check is pending', () => {
    /**
     * Regression: these entries used to be gated on composeStore.composeAvailable,
     * which is false until an async status fetch resolves. The menu therefore
     * grew extra items a moment after load, which read as a blink.
     */
    it('shows compose actions immediately for a compose folder', async () => {
      const wrapper = mountHeader({ compose_project: 'blog' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');

      const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
      expect(labels).toContain('Stack Up');
      expect(labels).toContain('Pull Latest Images');
      expect(labels).toContain('Stack Details');
    });

    it('disables them until compose availability is known', async () => {
      const wrapper = mountHeader({ compose_project: 'blog' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');

      const stackUp = wrapper
        .findAll('button.kebab-menu-item')
        .find((el) => el.text().trim() === 'Stack Up')!;

      expect(stackUp.attributes('disabled')).toBeDefined();
      expect(stackUp.attributes('title')).toBe('Checking Docker Compose availability...');
    });

    it('omits compose actions entirely for a non-compose folder', async () => {
      const wrapper = mountHeader();
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');

      const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
      expect(labels).not.toContain('Stack Up');
      expect(labels).not.toContain('Stack Details');
    });
  });

  describe('update-check entry while settings are pending', () => {
    /**
     * Regression: this entry was gated on settingsStore.enableUpdateChecks,
     * which is false until the settings fetch resolves. Whether update checks
     * are on is a capability, not folder data, so the entry must render
     * straight away and disable itself instead of appearing a moment later.
     */
    const openMenu = async (wrapper: ReturnType<typeof mountHeader>) => {
      const kebab = wrapper
        .findAll('button')
        .find((b) => b.attributes('title') === 'Folder actions')!;
      await kebab.trigger('click');
    };

    const folderWithImage = {
      containers: [{ container_name: 'nginx' } as unknown as Folder['containers'][number]],
    };

    it('shows the entry before settings land, disabled', async () => {
      const docker = useDockerStore();
      docker.containers = [{ name: 'nginx', image: 'nginx:latest' } as never];

      const wrapper = mountHeader(folderWithImage);
      await openMenu(wrapper);

      const entry = wrapper
        .findAll('button.kebab-menu-item')
        .find((el) => el.text().trim() === 'Check for Updates');

      expect(entry).toBeTruthy();
      expect(entry!.attributes('disabled')).toBeDefined();
      expect(entry!.attributes('title')).toBe('Loading settings…');
    });

    it('hides the entry once settings report update checks are off', async () => {
      const docker = useDockerStore();
      docker.containers = [{ name: 'nginx', image: 'nginx:latest' } as never];
      const settings = useSettingsStore();
      settings.loaded = true;
      settings.enableUpdateChecks = false;

      const wrapper = mountHeader(folderWithImage);
      await openMenu(wrapper);

      const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
      expect(labels).not.toContain('Check for Updates');
    });

    it('enables the entry once settings report update checks are on', async () => {
      const docker = useDockerStore();
      docker.containers = [{ name: 'nginx', image: 'nginx:latest' } as never];
      const settings = useSettingsStore();
      settings.loaded = true;
      settings.enableUpdateChecks = true;

      const wrapper = mountHeader(folderWithImage);
      await openMenu(wrapper);

      const entry = wrapper
        .findAll('button.kebab-menu-item')
        .find((el) => el.text().trim() === 'Check for Updates');

      expect(entry).toBeTruthy();
      expect(entry!.attributes('disabled')).toBeUndefined();
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
