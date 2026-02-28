import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FolderContainer from '../FolderContainer.vue';
import type { Folder } from '@/types/folder';
import type { Container } from '@/stores/docker';
import { useDockerStore } from '@/stores/docker';

function makeContainer(overrides: Partial<Container> = {}): Container {
  return {
    id: 'abc123',
    name: 'test-container',
    image: 'nginx:latest',
    state: 'running',
    status: 'Up 2 hours',
    command: '/entrypoint.sh',
    ports: [],
    mounts: [],
    networkSettings: {},
    created: Date.now() / 1000,
    icon: null,
    managed: 'dockerman',
    webui: null,
    labels: {},
    ...overrides,
  };
}

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

describe('FolderContainer concurrent action loading', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it('shows loading spinners on multiple containers simultaneously', async () => {
    const containers = [
      makeContainer({ id: 'c1', name: 'container-1' }),
      makeContainer({ id: 'c2', name: 'container-2' }),
      makeContainer({ id: 'c3', name: 'container-3', state: 'exited', status: 'Exited' }),
    ];

    const dockerStore = useDockerStore();
    dockerStore.containers = containers;

    // Create a folder with all three containers
    const folder = makeFolder({
      containers: [
        { id: 1, folder_id: 1, container_name: 'container-1', container_id: 'c1', position: 0 },
        { id: 2, folder_id: 1, container_name: 'container-2', container_id: 'c2', position: 1 },
        { id: 3, folder_id: 1, container_name: 'container-3', container_id: 'c3', position: 2 },
      ],
    });

    // Make stop/start never resolve so we can test concurrent state
    let resolveStop1: () => void;
    let resolveStop2: () => void;
    let resolveStart3: () => void;
    dockerStore.stopContainer = (id: string) =>
      new Promise<boolean>((resolve) => {
        if (id === 'c1') resolveStop1 = () => resolve(true);
        else resolveStop2 = () => resolve(true);
      });
    dockerStore.startContainer = (_id: string) =>
      new Promise<boolean>((resolve) => {
        resolveStart3 = () => resolve(true);
      });

    const wrapper = mount(FolderContainer, {
      props: { folder },
      global: {
        plugins: [pinia],
        stubs: { Teleport: true },
      },
    });

    // Find the ContainerCard components
    const cards = wrapper.findAllComponents({ name: 'ContainerCard' });
    expect(cards.length).toBe(3);

    // Trigger stop on container-1 (running containers have a stop button)
    cards[0].vm.$emit('stop', 'c1');
    await wrapper.vm.$nextTick();

    // Trigger stop on container-2
    cards[1].vm.$emit('stop', 'c2');
    await wrapper.vm.$nextTick();

    // Trigger start on container-3
    cards[2].vm.$emit('start', 'c3');
    await wrapper.vm.$nextTick();

    // All three should show loading spinners
    const spinners = wrapper.findAll('.animate-spin');
    expect(spinners.length).toBe(3);

    // Verify each card shows the correct action text
    expect(cards[0].text()).toContain('Stopping...');
    expect(cards[1].text()).toContain('Stopping...');
    expect(cards[2].text()).toContain('Starting...');

    // Resolve container-1 stop — only its spinner should disappear
    resolveStop1!();
    await wrapper.vm.$nextTick();
    // Small delay for async resolution
    await new Promise((r) => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(cards[0].find('.animate-spin').exists()).toBe(false);
    expect(cards[1].find('.animate-spin').exists()).toBe(true);
    expect(cards[2].find('.animate-spin').exists()).toBe(true);

    // Resolve remaining
    resolveStop2!();
    resolveStart3!();
    await new Promise((r) => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.animate-spin').length).toBe(0);
  });
});
