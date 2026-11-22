import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import StacksPane from '../StacksPane.vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useComposeStore } from '@/stores/compose';
import { makeContainer, makeFolder } from '@/test/fixtures';
import type { ComposeStack } from '@/types/compose';

const PROJECT = 'com.docker.compose.project';

function makeStack(project_name: string): ComposeStack {
  return {
    project_name,
    working_dir: null,
    compose_file: null,
    env_file: null,
    autostart: false,
    autostart_force_recreate: false,
    description: null,
    imported_from: null,
    services_running: 0,
    services_total: 0,
  };
}

// The component must share the pinia the test writes to.
let pinia: Pinia;

function mountPane() {
  return mount(StacksPane, { global: { plugins: [pinia] } });
}

const rowFor = (wrapper: ReturnType<typeof mountPane>, project: string) =>
  wrapper.findAll('button[aria-pressed]').find((b) => b.text().includes(project))!;

describe('StacksPane', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    const docker = useDockerStore();
    docker.containers = [
      makeContainer({ id: 's', name: 'sonarr', labels: { [PROJECT]: 'arr' } }),
      makeContainer({ id: 'r', name: 'radarr', state: 'exited', labels: { [PROJECT]: 'arr' } }),
      makeContainer({ id: 'p', name: 'prowlarr', labels: { [PROJECT]: 'arr' } }),
      makeContainer({ id: 'g', name: 'grafana', labels: { [PROJECT]: 'monitoring' } }),
      makeContainer({ id: 'x', name: 'plex' }),
    ];
    useFolderStore().folders = [
      makeFolder(['sonarr', 'radarr', 'plex'], { id: 1, name: 'Media' }),
      makeFolder(['prowlarr'], { id: 2, name: 'Downloads' }),
    ];
    const compose = useComposeStore();
    compose.stacks = [makeStack('arr'), makeStack('paperless')];
    // Compose actions stay disabled until the status check says they work.
    compose.status = { ...compose.status, compose_available: true, management_enabled: true };
    compose.statusChecked = true;
  });

  it('lists known stacks and label-only projects, sorted, but not plain containers', () => {
    const names = mountPane().findAll('button[aria-pressed] .text-sm').map((el) => el.text());
    expect(names).toEqual(['arr', 'monitoring', 'paperless']);
  });

  describe('Compose Manager group', () => {
    const fromManager = (name: string): ComposeStack => ({
      ...makeStack(name),
      working_dir: `/boot/config/plugins/compose.manager/projects/${name}`,
      source: 'compose_manager',
    });
    const names = (wrapper: ReturnType<typeof mountPane>) =>
      wrapper.findAll('button[aria-pressed] .text-sm').map((el) => el.text());
    const subHeader = (wrapper: ReturnType<typeof mountPane>) =>
      wrapper.findAll('h3').filter((h) => h.text() === 'Compose Manager');

    it('shows no sub-header when no stack is from Compose Manager', () => {
      expect(subHeader(mountPane())).toHaveLength(0);
    });

    it('lists those stacks last under a sub-header with their count', () => {
      useComposeStore().stacks = [makeStack('arr'), makeStack('paperless'), fromManager('alpha'), fromManager('beta')];
      const wrapper = mountPane();
      expect(names(wrapper)).toEqual(['arr', 'monitoring', 'paperless', 'alpha', 'beta']);
      expect(subHeader(wrapper)).toHaveLength(1);
      expect(subHeader(wrapper)[0].element.parentElement!.textContent).toContain('2');
      // The pane header still counts every stack.
      expect(wrapper.find('h2').element.parentElement!.textContent).toContain('5');
      // The sub-header sits between the two groups.
      const text = wrapper.text();
      expect(text.indexOf('paperless')).toBeLessThan(text.indexOf('Compose Manager'));
      expect(text.indexOf('Compose Manager')).toBeLessThan(text.indexOf('alpha'));
    });

    it('shows the sub-header when every stack is from Compose Manager', () => {
      useDockerStore().containers = [];
      useComposeStore().stacks = [fromManager('alpha'), fromManager('beta')];
      const wrapper = mountPane();
      expect(names(wrapper)).toEqual(['alpha', 'beta']);
      expect(subHeader(wrapper)).toHaveLength(1);
    });

    it('keeps the same kebab on a Compose Manager row', async () => {
      useComposeStore().stacks = [fromManager('alpha')];
      const wrapper = mountPane();
      await wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for alpha')!.trigger('click');
      const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
      expect(labels).toContain('Remove Stack');
      expect(labels).toContain('Schedules');
    });
  });

  it('counts running members from docker state', () => {
    expect(rowFor(mountPane(), 'arr').text()).toContain('2/3');
  });

  it('names every folder the members live in', () => {
    const wrapper = mountPane();
    expect(rowFor(wrapper, 'arr').text()).toContain('In Media, Downloads');
    expect(rowFor(wrapper, 'monitoring').text()).toContain('In Unfoldered');
    expect(rowFor(wrapper, 'paperless').text()).toContain('Not created');
  });

  it('picks a stack, and clicking it again clears the filter', async () => {
    const wrapper = mountPane();
    const docker = useDockerStore();
    await rowFor(wrapper, 'arr').trigger('click');
    expect(docker.stackFilter).toBe('arr');
    expect(rowFor(wrapper, 'arr').attributes('aria-pressed')).toBe('true');
    await rowFor(wrapper, 'arr').trigger('click');
    expect(docker.stackFilter).toBeNull();
  });

  it('emits the stack actions from its kebab', async () => {
    const wrapper = mountPane();
    await wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for arr')!.trigger('click');
    const item = (label: string) => wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === label);
    // Same rule as the folder kebab: a running stack offers stop, not up.
    expect(item('Stack Up')).toBeUndefined();
    expect(item('Stop All')).toBeTruthy();
    await item('Pull Latest Images')!.trigger('click');
    expect(wrapper.emitted('compose-pull')).toEqual([['arr']]);
  });

  it('offers no Stack Down for a stack with no containers', async () => {
    const wrapper = mountPane();
    await wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for paperless')!.trigger('click');
    const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
    expect(labels).toContain('Stack Up');
    expect(labels).not.toContain('Stack Down');
    expect(labels).not.toContain('Stop All');
  });

  it('runs Stop All through the shared stack action, and emits Stack Down for App to confirm', async () => {
    const compose = useComposeStore();
    compose.runStackAction = vi.fn(async () => {});
    const wrapper = mountPane();
    const openMenu = () => wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for arr')!.trigger('click');
    const item = (label: string) => wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === label)!;
    await openMenu();
    await item('Stop All').trigger('click');
    expect(compose.runStackAction).toHaveBeenCalledWith('arr', 'stop');
    await openMenu();
    await item('Stack Down').trigger('click');
    expect(wrapper.emitted('compose-down')).toEqual([['arr']]);
  });

  it('shows a running or failed stack action on the row', async () => {
    const compose = useComposeStore();
    compose.stackActionStatus.set('arr', { kind: 'down', error: 'compose down failed' });
    const wrapper = mountPane();
    await flushPromises();
    expect(rowFor(wrapper, 'arr').text()).toContain('compose down failed');
  });

  it('offers Remove Stack for a stored stack, and emits it for App to confirm', async () => {
    const wrapper = mountPane();
    await wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for paperless')!.trigger('click');
    const item = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Remove Stack')!;
    expect(item).toBeTruthy();
    await item.trigger('click');
    expect(wrapper.emitted('compose-remove')).toEqual([['paperless']]);
  });

  it('offers no Remove Stack for a project seen only on container labels', async () => {
    const wrapper = mountPane();
    await wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for monitoring')!.trigger('click');
    const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
    expect(labels).not.toContain('Remove Stack');
  });

  it('disables Remove Stack while another action runs on the stack', async () => {
    useComposeStore().stackActionStatus.set('paperless', { kind: 'down' });
    const wrapper = mountPane();
    await wrapper.findAll('button').find((b) => b.attributes('title') === 'Actions for paperless')!.trigger('click');
    const item = wrapper.findAll('.kebab-menu-item').find((el) => el.text().trim() === 'Remove Stack')!;
    expect(item.attributes('disabled')).toBeDefined();
  });
});
