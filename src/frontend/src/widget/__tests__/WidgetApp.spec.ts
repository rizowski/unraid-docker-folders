import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WidgetApp from '../WidgetApp.vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore, type ContainerStats } from '@/stores/stats';
import { useUpdatesStore } from '@/stores/updates';
import { useScheduleStore } from '@/stores/schedules';
import { makeContainer, makeFolder, makeUpdateStatus } from '@/test/fixtures';
import type { Schedule } from '@/types/schedule';
import type { Container } from '@/stores/docker';
import type { Folder } from '@/types/folder';

vi.mock('@/composables/useWebSocket', () => ({ initWebSocket: vi.fn() }));

const COLLAPSE_KEY = 'docker-folders-widget-collapsed';
const SETTINGS_KEY = 'docker-folders-widget-settings';

/** Most tests look at rows, so they turn off the default collapse. */
function saveSettings(settings: Record<string, boolean>) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

interface Extras {
  stats?: Record<string, Partial<ContainerStats>>;
  updates?: string[];
  enableUpdateChecks?: boolean;
  schedules?: Array<Partial<Schedule>>;
}

function setup(containers: Container[], folders: Folder[], extras: Extras = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const dockerStore = useDockerStore();
  const folderStore = useFolderStore();
  const settingsStore = useSettingsStore();
  dockerStore.fetchContainers = vi.fn(async () => {});
  folderStore.fetchFolders = vi.fn(async () => {});
  // The real fetchSettings sets `loaded` only when it succeeds, and the widget
  // reads that flag before it loads update tags.
  settingsStore.fetchSettings = vi.fn(async () => {
    settingsStore.loaded = true;
  });
  settingsStore.enableUpdateChecks = extras.enableUpdateChecks ?? false;
  const statsStore = useStatsStore();
  statsStore.registerVisible = vi.fn();
  statsStore.unregisterVisible = vi.fn();
  statsStore.stats = Object.fromEntries(
    Object.entries(extras.stats ?? {}).map(([id, s]) => [id, { cpuPercent: 0, memoryPercent: 0, memoryUsage: 0, memoryLimit: 1, restartCount: 0, ...s } as ContainerStats]),
  );
  const updatesStore = useUpdatesStore();
  updatesStore.fetchCachedUpdates = vi.fn(async () => {});
  updatesStore.updates = Object.fromEntries((extras.updates ?? []).map((image) => [image, makeUpdateStatus(image, true)]));
  const scheduleStore = useScheduleStore();
  scheduleStore.fetchSchedules = vi.fn(async () => {});
  scheduleStore.schedules = (extras.schedules ?? []).map((s, i) => ({ id: i + 1, name: `job${i + 1}`, enabled: true, last_run_status: 'error', last_run_message: 'boom', ...s }) as Schedule);
  dockerStore.stopContainer = vi.fn(async () => true);
  dockerStore.startContainer = vi.fn(async () => true);
  dockerStore.containers = containers;
  folderStore.folders = folders;
  return { pinia, dockerStore, statsStore, scheduleStore, updatesStore };
}

async function mountWidget(containers: Container[], folders: Folder[], extras: Extras = {}) {
  const stores = setup(containers, folders, extras);
  const wrapper = mount(WidgetApp, { global: { plugins: [stores.pinia] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, ...stores };
}

const rowText = (w: VueWrapper, name: string) =>
  w.findAll('.widget-row').find((r) => r.find('span.truncate').text() === name)!.text();

const groupNames = (w: VueWrapper) => w.findAll('section [role="button"] .font-semibold').map((e) => e.text());
const rowNames = (w: VueWrapper) => w.findAll('.widget-row span.truncate').map((e) => e.text());

async function openMenu(w: VueWrapper, name: string) {
  await w.find(`button[title="Actions for ${name}"]`).trigger('click');
  await flushPromises();
  return w.findAll('.kebab-menu-item');
}

describe('WidgetApp', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
    saveSettings({ startCollapsed: false });
  });

  const containers = [
    makeContainer({ id: 'c1', name: 'plex', image: 'linuxserver/plex', webui: 'http://[IP]:32400/web' }),
    makeContainer({ id: 'c2', name: 'sonarr', image: 'linuxserver/sonarr', state: 'exited' }),
    makeContainer({ id: 'c3', name: 'redis', image: 'redis:7' }),
  ];

  it('lists folders in order with their members, then an Other group', async () => {
    const { wrapper } = await mountWidget(containers, [makeFolder(['sonarr', 'plex'])]);
    expect(groupNames(wrapper)).toEqual(['Media', 'Other']);
    expect(rowNames(wrapper)).toEqual(['sonarr', 'plex', 'redis']);
    expect(wrapper.text()).toContain('1/2');
  });

  it('hides the Other group when every container is in a folder', async () => {
    const { wrapper } = await mountWidget(containers, [makeFolder(['plex', 'sonarr', 'redis'])]);
    expect(groupNames(wrapper)).toEqual(['Media']);
  });

  it('filters rows by name or image and drops groups with no match', async () => {
    const { wrapper } = await mountWidget(containers, [makeFolder(['plex', 'sonarr'])]);
    await wrapper.find('input').setValue('redis:');
    expect(groupNames(wrapper)).toEqual(['Other']);
    expect(rowNames(wrapper)).toEqual(['redis']);

    await wrapper.find('input').setValue('zzz');
    expect(wrapper.text()).toContain('No containers match.');
  });

  it('expands collapsed groups while searching', async () => {
    saveSettings({ startCollapsed: true });
    const { wrapper } = await mountWidget(containers, [makeFolder(['plex'])]);
    expect(rowNames(wrapper)).toEqual([]);
    await wrapper.find('input').setValue('plex');
    expect(rowNames(wrapper)).toEqual(['plex']);
  });

  it('starts collapsed by default and keeps its own collapse state', async () => {
    window.localStorage.clear();
    const folder = makeFolder(['plex']);
    const { wrapper } = await mountWidget(containers, [folder]);
    expect(rowNames(wrapper)).toEqual([]);

    await wrapper.find('section [role="button"]').trigger('click');
    expect(rowNames(wrapper)).toEqual(['plex']);
    expect(JSON.parse(window.localStorage.getItem(COLLAPSE_KEY)!)).toEqual({ 'folder-1': false });
    // The Folders page state is untouched.
    expect(folder.collapsed).toBe(false);
  });

  it('opens the settings panel on a message from the dashboard page', async () => {
    const { wrapper } = await mountWidget(containers, []);
    expect(wrapper.text()).not.toContain('Widget settings');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'docker-folders-widget-settings' },
      origin: window.location.origin,
      source: window.parent,
    }));
    await flushPromises();
    expect(wrapper.text()).toContain('Widget settings');
  });

  it('ignores a settings message from another origin', async () => {
    const { wrapper } = await mountWidget(containers, []);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'docker-folders-widget-settings' },
      origin: 'http://evil.example',
      source: window.parent,
    }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('Widget settings');
  });

  it('hides stopped containers and saves the choice from the panel', async () => {
    const { wrapper } = await mountWidget(containers, [makeFolder(['sonarr', 'plex'])]);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'docker-folders-widget-settings' },
      origin: window.location.origin,
      source: window.parent,
    }));
    await flushPromises();
    const hideStopped = wrapper.findAll('label').find((l) => l.text() === 'Hide stopped containers')!;
    await hideStopped.find('input').setValue(true);

    expect(rowNames(wrapper)).toEqual(['plex', 'redis']);
    // The count still covers the hidden member.
    expect(wrapper.text()).toContain('1/2');
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_KEY)!).hideStopped).toBe(true);
  });

  it('shows a WebUI link on running containers and a disabled icon on the rest', async () => {
    // radarr is configured but stopped, which is the second disabled reason.
    const withStopped = [
      ...containers,
      makeContainer({ id: 'c4', name: 'radarr', image: 'linuxserver/radarr', state: 'exited', webui: 'http://[IP]:7878' }),
    ];
    const { wrapper } = await mountWidget(withStopped, []);
    expect(wrapper.find('a[title="Open WebUI for plex"]').attributes('href')).toBe(`http://${window.location.hostname}:32400/web`);
    // Every row keeps the icon column, so the kebab menus line up down the tile.
    expect(wrapper.findAll('.widget-row a[title^="Open WebUI"], .widget-row span[title*="WebUI"]')).toHaveLength(withStopped.length);
    expect(wrapper.find('span[title="radarr is not running, so its WebUI is unavailable."]').exists()).toBe(true);
    expect(wrapper.findAll('span[title^="No WebUI configured"]')).toHaveLength(2);
    wrapper.unmount();

    saveSettings({ startCollapsed: false, showWebui: false });
    const second = await mountWidget(withStopped, []);
    expect(second.wrapper.find('a[title="Open WebUI for plex"]').exists()).toBe(false);
    expect(second.wrapper.findAll('span[title*="WebUI"]')).toHaveLength(0);
  });

  it('shows a status dot in place of the icon when icons are off', async () => {
    saveSettings({ startCollapsed: false, showIcons: false });
    const { wrapper } = await mountWidget(containers, []);
    expect(wrapper.findAll('.widget-row img')).toHaveLength(0);
    expect(wrapper.findAll('.widget-row span.rounded-full')).toHaveLength(3);
  });

  it('offers Stop, Edit and Logs for a running managed container', async () => {
    const { wrapper, dockerStore } = await mountWidget(containers, []);
    const items = await openMenu(wrapper, 'plex');
    expect(items.map((i) => i.text())).toEqual(['Stop', 'Edit', 'Logs']);

    await items[0].trigger('click');
    await flushPromises();
    expect(dockerStore.stopContainer).toHaveBeenCalledWith('c1');
  });

  it('offers Start for a stopped container', async () => {
    const { wrapper, dockerStore } = await mountWidget(containers, []);
    const items = await openMenu(wrapper, 'sonarr');
    expect(items[0].text()).toBe('Start');
    await items[0].trigger('click');
    await flushPromises();
    expect(dockerStore.startContainer).toHaveBeenCalledWith('c2');
  });

  it('disables Edit for unmanaged containers and hides Logs for compose ones', async () => {
    const compose = makeContainer({
      id: 'c9',
      name: 'app',
      managed: null,
      labels: { 'com.docker.compose.project': 'stack' },
    });
    const { wrapper } = await mountWidget([compose], []);
    const items = await openMenu(wrapper, 'app');
    expect(items.map((i) => i.text())).toEqual(['Stop', 'Edit']);
    expect(items[1].attributes('disabled')).toBeDefined();
  });

  describe('stats', () => {
    it('shows CPU and memory percent on running rows when turned on', async () => {
      saveSettings({ startCollapsed: false, showStats: true });
      const { wrapper, statsStore } = await mountWidget(containers, [], { stats: { c1: { cpuPercent: 3.14, memoryPercent: 91 } } });
      expect(rowText(wrapper, 'plex')).toContain('3.1%');
      expect(rowText(wrapper, 'plex')).toContain('91.0%');
      // A running row with no stats yet shows placeholders. A stopped row shows nothing.
      expect(rowText(wrapper, 'redis')).toContain('--');
      expect(rowText(wrapper, 'sonarr')).not.toContain('%');
      expect(statsStore.registerVisible).toHaveBeenCalledWith('c1');
      expect(statsStore.registerVisible).not.toHaveBeenCalledWith('c2');
      expect(wrapper.find('.widget-row .text-error').text()).toBe('91.0%');
      // A bar under each percent, filled to the value.
      const bars = wrapper.findAll('.widget-row .widget-stat .rounded-full.block');
      expect(bars.map((b) => b.attributes('style'))).toEqual(['width: 3.14%;', 'width: 91%;']);
      expect(bars[1].classes()).toContain('bg-error');
    });

    it('registers nothing and shows no numbers when off', async () => {
      const { wrapper, statsStore } = await mountWidget(containers, [], { stats: { c1: { cpuPercent: 3 } } });
      expect(rowText(wrapper, 'plex')).not.toContain('%');
      expect(statsStore.registerVisible).not.toHaveBeenCalled();
    });
  });

  describe('tags', () => {
    it('shows Update only when update checks are on', async () => {
      const { wrapper } = await mountWidget(containers, [makeFolder(['plex'])], { updates: ['linuxserver/plex'], enableUpdateChecks: true });
      expect(rowText(wrapper, 'plex')).toContain('Update');
      expect(wrapper.find('section [role="button"]').text()).toContain('1 update');
      wrapper.unmount();

      const off = await mountWidget(containers, [], { updates: ['linuxserver/plex'] });
      expect(rowText(off.wrapper, 'plex')).not.toContain('Update');
    });

    it('shows a restart tag at 3 restarts, not at 2', async () => {
      saveSettings({ startCollapsed: false, showStats: true });
      const { wrapper } = await mountWidget(containers, [], { stats: { c1: { restartCount: 3 }, c3: { restartCount: 2 } } });
      expect(rowText(wrapper, 'plex')).toContain('3 rst');
      expect(rowText(wrapper, 'redis')).not.toContain('rst');
    });

    it('shows Failed for a failed container or stack schedule, not a disabled one', async () => {
      const app = makeContainer({ id: 'c4', name: 'app', labels: { 'com.docker.compose.project': 'stack' } });
      const { wrapper } = await mountWidget([...containers, app], [makeFolder(['plex', 'app', 'redis'])], {
        schedules: [
          { target_type: 'container', target_id: 'plex' },
          { target_type: 'stack', target_id: 'stack' },
          { target_type: 'container', target_id: 'redis', enabled: false },
        ],
      });
      expect(rowText(wrapper, 'plex')).toContain('Failed');
      expect(rowText(wrapper, 'app')).toContain('Failed');
      expect(rowText(wrapper, 'redis')).not.toContain('Failed');
      expect(wrapper.find('section [role="button"]').text()).toContain('2 failed');
    });

    it('loads schedules and updates only while tags are on', async () => {
      saveSettings({ startCollapsed: false, showTags: false });
      const { wrapper, scheduleStore, updatesStore } = await mountWidget(containers, [], { enableUpdateChecks: true });
      expect(scheduleStore.fetchSchedules).not.toHaveBeenCalled();
      expect(updatesStore.fetchCachedUpdates).not.toHaveBeenCalled();
      wrapper.unmount();

      saveSettings({ startCollapsed: false });
      const on = await mountWidget(containers, [], { enableUpdateChecks: true });
      expect(on.scheduleStore.fetchSchedules).toHaveBeenCalled();
      expect(on.updatesStore.fetchCachedUpdates).toHaveBeenCalled();
    });

    it('hides every tag when turned off', async () => {
      saveSettings({ startCollapsed: false, showStats: true, showTags: false });
      const { wrapper } = await mountWidget(containers, [makeFolder(['plex'])], {
        updates: ['linuxserver/plex'],
        enableUpdateChecks: true,
        stats: { c1: { restartCount: 5 } },
        schedules: [{ target_type: 'container', target_id: 'plex' }],
      });
      const text = rowText(wrapper, 'plex');
      expect(text).not.toMatch(/Update|rst|Failed/);
      expect(wrapper.find('section [role="button"]').text()).not.toMatch(/update|failed/);
    });
  });
});
