import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import FolderHeader from '../FolderHeader.vue';
import { useDockerStore } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { makeContainer, makeContainerStats } from '@/test/fixtures';
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
    sort_mode: 'manual',
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
    props: { folder: makeFolder(folder), collapsed: !!makeFolder(folder).collapsed },
    global: {
      plugins: [pinia],
    },
  });
}

const openKebab = async (wrapper: ReturnType<typeof mountHeader>) => {
  const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
  await kebab.trigger('click');
};

/** Open the kebab, then the named submenu. Returns false if it is not shown. */
const openSubmenu = async (wrapper: ReturnType<typeof mountHeader>, label: string) => {
  await openKebab(wrapper);
  const parent = wrapper.findAll('button[aria-haspopup="menu"]').find((el) => el.text().trim() === label);
  if (!parent) return false;
  await parent.trigger('click');
  return true;
};

const menuLabels = (wrapper: ReturnType<typeof mountHeader>) =>
  wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());

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

  it('groups the menu into Sort and Folder Options submenus', async () => {
    const wrapper = mountHeader();
    await openKebab(wrapper);

    // No images and no compose project, so Actions has nothing and hides.
    expect(menuLabels(wrapper)).toEqual(['Folder Options', 'Sort']);
  });

  it('lists every sort mode under Sort', async () => {
    const wrapper = mountHeader();
    await openSubmenu(wrapper, 'Sort');

    expect(menuLabels(wrapper)).toContain('Name (A → Z)');
    expect(menuLabels(wrapper)).toContain('Oldest first');
  });

  it('Folder Options contains edit and delete', async () => {
    const wrapper = mountHeader();
    await openSubmenu(wrapper, 'Folder Options');

    expect(menuLabels(wrapper)).toContain('Edit Folder');
    expect(menuLabels(wrapper)).toContain('Delete Folder');
  });

  it('clicking Edit Folder emits edit event and closes menu', async () => {
    const wrapper = mountHeader();
    await openSubmenu(wrapper, 'Folder Options');

    const editBtn = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Edit Folder')!;
    await editBtn.trigger('click');

    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')!.length).toBe(1);
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('clicking Delete Folder emits delete event and closes menu', async () => {
    const wrapper = mountHeader();
    await openSubmenu(wrapper, 'Folder Options');

    const deleteBtn = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Delete Folder')!;
    await deleteBtn.trigger('click');

    expect(wrapper.emitted('delete')).toBeTruthy();
    expect(wrapper.emitted('delete')!.length).toBe(1);
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  describe('collapse toggle', () => {
    const toggle = (w: ReturnType<typeof mountHeader>) => w.find('button[aria-expanded]');

    it('reports the shown state, not the saved one, when a filter holds a collapsed folder open', () => {
      const wrapper = mount(FolderHeader, {
        props: { folder: makeFolder({ collapsed: true }), collapsed: false },
        global: { plugins: [pinia] },
      });
      expect(toggle(wrapper).attributes('aria-expanded')).toBe('true');
      expect(toggle(wrapper).attributes('aria-label')).toBe('Collapse folder Test Folder');
    });

    it('reports collapsed when the shown state is collapsed', () => {
      const wrapper = mountHeader({ collapsed: true });
      expect(toggle(wrapper).attributes('aria-expanded')).toBe('false');
      expect(toggle(wrapper).attributes('aria-label')).toBe('Expand folder Test Folder');
    });

    it('puts the button role and state on the chevron, not on the container', () => {
      const wrapper = mountHeader();
      const header = wrapper.find('.folder-header');
      expect(header.attributes('role')).toBeUndefined();
      expect(header.attributes('tabindex')).toBeUndefined();
      expect(header.attributes('aria-expanded')).toBeUndefined();
      expect(header.attributes('aria-label')).toBeUndefined();
      expect(toggle(wrapper).element.tagName).toBe('BUTTON');
      expect(toggle(wrapper).attributes('type')).toBe('button');
    });

    it('emits once when the chevron button is clicked, not again from the header', async () => {
      const wrapper = mountHeader();
      await toggle(wrapper).trigger('click');
      expect(wrapper.emitted('toggle-collapse')).toHaveLength(1);
    });

    it('still toggles on a click anywhere else in the header', async () => {
      const wrapper = mountHeader();
      await wrapper.find('h2').trigger('click');
      expect(wrapper.emitted('toggle-collapse')).toHaveLength(1);
    });

    it('cancels a repeated Enter keydown, so a held key does not toggle again', async () => {
      const wrapper = mountHeader();
      const first = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
      const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, cancelable: true, bubbles: true });
      toggle(wrapper).element.dispatchEvent(first);
      toggle(wrapper).element.dispatchEvent(repeat);
      expect(first.defaultPrevented).toBe(false);
      expect(repeat.defaultPrevented).toBe(true);
    });

    it('keeps the inner controls reachable and outside any button role', () => {
      const wrapper = mountHeader();
      const header = wrapper.find('.folder-header');
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'Folder actions')!;
      expect(kebab.exists()).toBe(true);
      expect(header.element.closest('[role="button"]')).toBeNull();
      expect(kebab.element.closest('[role="button"]')).toBeNull();
    });

    it('keeps the drag handle the sortable list looks for', () => {
      const wrapper = mountHeader();
      expect(wrapper.find('.folder-drag-handle').exists()).toBe(true);
    });
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
      await openSubmenu(wrapper, 'Actions');
      expect(menuLabels(wrapper)).toContain('Stack Up');
      expect(menuLabels(wrapper)).toContain('Pull Latest Images');
      expect(menuLabels(wrapper)).toContain('Edit Stack');
    });

    it('lists Actions and Folder Options alphabetically, with Delete Folder last', async () => {
      const docker = useDockerStore();
      docker.containers = [{ name: 'db', image: 'postgres:16' } as never];
      const settings = useSettingsStore();
      settings.loaded = true;
      settings.enableUpdateChecks = true;
      const containers = [{ container_name: 'db' } as unknown as Folder['containers'][number]];

      const wrapper = mountHeader({ compose_project: 'blog', containers });
      await openSubmenu(wrapper, 'Actions');
      expect(menuLabels(wrapper).slice(3)).toEqual(['Check for Updates', 'Edit Stack', 'Pull Latest Images', 'Stack Up']);

      await wrapper.find('button[aria-expanded="true"]').trigger('click');
      const options = wrapper.findAll('button[aria-haspopup="menu"]').find((el) => el.text().trim() === 'Folder Options')!;
      await options.trigger('click');
      expect(menuLabels(wrapper).slice(3)).toEqual(['Edit Folder', 'Enable Stack Autostart', 'Delete Folder']);
    });

    it('disables them until compose availability is known', async () => {
      const wrapper = mountHeader({ compose_project: 'blog' });
      await openSubmenu(wrapper, 'Actions');

      const stackUp = wrapper
        .findAll('button.kebab-menu-item')
        .find((el) => el.text().trim() === 'Stack Up')!;

      expect(stackUp.attributes('disabled')).toBeDefined();
      expect(stackUp.attributes('title')).toBe('Checking Docker Compose availability...');
    });

    it('omits compose actions entirely for a non-compose folder', async () => {
      const wrapper = mountHeader();
      expect(await openSubmenu(wrapper, 'Actions')).toBe(false);
      expect(menuLabels(wrapper)).not.toContain('Edit Stack');
    });
  });

  describe('update-check entry while settings are pending', () => {
    /**
     * Regression: this entry was gated on settingsStore.enableUpdateChecks,
     * which is false until the settings fetch resolves. Whether update checks
     * are on is a capability, not folder data, so the entry must render
     * straight away and disable itself instead of appearing a moment later.
     */
    const openMenu = (wrapper: ReturnType<typeof mountHeader>) => openSubmenu(wrapper, 'Actions');

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
      // Update checks were the only action, so the submenu hides with it.
      expect(await openMenu(wrapper)).toBe(false);
      expect(menuLabels(wrapper)).not.toContain('Check for Updates');
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

  it('counts crashed containers, and not ones that were stopped', () => {
    useDockerStore().containers = [
      makeContainer({ name: 'pg', state: 'exited', status: 'Exited (1) 12 hours ago' }),
      makeContainer({ name: 'web', state: 'exited', status: 'Exited (0) 2 days ago' }),
      makeContainer({ name: 'arr', state: 'running', status: 'Up 2 hours' }),
    ];
    const containers = ['pg', 'web', 'arr'].map((name) => ({ container_name: name }) as unknown as Folder['containers'][number]);
    const pill = mountHeader({ containers }).findAll('span').find((s) => s.attributes('title')?.startsWith('pg:'));
    expect(pill?.text()).toContain('1 crashed');
    expect(pill?.attributes('title')).toBe('pg: Exited (1) 12 hours ago');
  });

  it('shows no crashed count when nothing crashed', () => {
    useDockerStore().containers = [makeContainer({ name: 'web', state: 'exited', status: 'Exited (0) 2 days ago' })];
    const wrapper = mountHeader({ containers: [{ container_name: 'web' } as unknown as Folder['containers'][number]] });
    expect(wrapper.text()).not.toContain('crashed');
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

  describe('collapsed folder stats', () => {
    const GB = 1024 ** 3;
    const entry = (cpuPercent: number, memoryUsage: number) =>
      makeContainerStats({ cpuPercent, memoryUsage, memoryLimit: 32 * GB, hostCpus: 8, hostMemory: 32 * GB });

    it('adds up the members instead of averaging them', () => {
      const docker = useDockerStore();
      docker.containers = [makeContainer({ id: 'a', name: 'a' }), makeContainer({ id: 'b', name: 'b' })];
      useStatsStore().stats = { a: entry(400, 4 * GB), b: entry(0, 4 * GB) };

      const wrapper = mountHeader({
        collapsed: true,
        containers: [{ container_name: 'a' }, { container_name: 'b' }] as unknown as Folder['containers'],
      });

      // CPU: 400% + 0%, on the rows' one-core scale, not 400% over 8 host
      // cores. Memory: 8 GB of 32 GB. An average would have shown 200% CPU.
      const text = wrapper.text();
      expect(text).toContain('400.0%');
      expect(text).toContain('25.0%');
      expect(text).not.toContain('200.0%');
      expect(text).not.toContain('50.0%');
    });

    it('names host memory in the tooltip when the host figure is reported', () => {
      useDockerStore().containers = [makeContainer({ id: 'a', name: 'a' })];
      useStatsStore().stats = { a: entry(10, 4 * GB) };
      const wrapper = mountHeader({
        collapsed: true,
        containers: [{ container_name: 'a' }] as unknown as Folder['containers'],
      });
      const bars = wrapper.findAllComponents({ name: 'StatsBar' });
      expect(bars[bars.length - 1].props('title')).toContain('host memory');
    });

    it('does not call the total host memory when the host figure is missing', () => {
      useDockerStore().containers = [makeContainer({ id: 'a', name: 'a' })];
      useStatsStore().stats = {
        a: makeContainerStats({ cpuPercent: 10, memoryUsage: 4 * GB, memoryLimit: 32 * GB, hostMemory: undefined }),
      };
      const wrapper = mountHeader({
        collapsed: true,
        containers: [{ container_name: 'a' }] as unknown as Folder['containers'],
      });
      const bars = wrapper.findAllComponents({ name: 'StatsBar' });
      const title = bars[bars.length - 1].props('title') as string;
      expect(title).not.toContain('host');
      expect(title).toContain('4.0 GB');
    });
  });
});
