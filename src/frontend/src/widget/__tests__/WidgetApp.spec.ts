import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WidgetApp from '../WidgetApp.vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { makeContainer, makeFolder } from '@/test/fixtures';
import type { Container } from '@/stores/docker';
import type { Folder } from '@/types/folder';

vi.mock('@/composables/useWebSocket', () => ({ initWebSocket: vi.fn() }));

const COLLAPSE_KEY = 'docker-folders-widget-collapsed';
const SETTINGS_KEY = 'docker-folders-widget-settings';

/** Most tests look at rows, so they turn off the default collapse. */
function saveSettings(settings: Record<string, boolean>) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function setup(containers: Container[], folders: Folder[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const dockerStore = useDockerStore();
  const folderStore = useFolderStore();
  const settingsStore = useSettingsStore();
  dockerStore.fetchContainers = vi.fn(async () => {});
  folderStore.fetchFolders = vi.fn(async () => {});
  settingsStore.fetchSettings = vi.fn(async () => {});
  dockerStore.stopContainer = vi.fn(async () => true);
  dockerStore.startContainer = vi.fn(async () => true);
  dockerStore.containers = containers;
  folderStore.folders = folders;
  return { pinia, dockerStore };
}

async function mountWidget(containers: Container[], folders: Folder[]) {
  const { pinia, dockerStore } = setup(containers, folders);
  const wrapper = mount(WidgetApp, { global: { plugins: [pinia] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, dockerStore };
}

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

  it('shows a WebUI link on running containers, unless turned off', async () => {
    const { wrapper } = await mountWidget(containers, []);
    expect(wrapper.find('a[title="Open WebUI for plex"]').attributes('href')).toBe(`http://${window.location.hostname}:32400/web`);
    wrapper.unmount();

    saveSettings({ startCollapsed: false, showWebui: false });
    const second = await mountWidget(containers, []);
    expect(second.wrapper.find('a[title="Open WebUI for plex"]').exists()).toBe(false);
  });

  it('shows a status dot in place of the icon when icons are off', async () => {
    saveSettings({ startCollapsed: false, showIcons: false });
    const { wrapper } = await mountWidget(containers, []);
    expect(wrapper.findAll('.widget-row img')).toHaveLength(0);
    expect(wrapper.findAll('.widget-row .status-dot')).toHaveLength(3);
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
});
