import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import FolderContainer from '../FolderContainer.vue';
import type { Folder } from '@/types/folder';
import { useDockerStore } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { makeContainer } from '@/test/fixtures';

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

  it('expand-grid exists as sibling after header', () => {
    const wrapper = mount(FolderContainer, {
      props: { folder: makeFolder() },
      global: { plugins: [createPinia()] },
    });
    const grid = wrapper.find('.expand-grid');
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

  it('resuming a paused container calls dockerStore.resumeContainer and clears the spinner on completion', async () => {
    const containers = [makeContainer({ id: 'c1', name: 'container-1', state: 'paused', status: 'Up 1 hour (Paused)' })];

    const dockerStore = useDockerStore();
    dockerStore.containers = containers;

    const folder = makeFolder({
      containers: [
        { id: 1, folder_id: 1, container_name: 'container-1', container_id: 'c1', position: 0 },
      ],
    });

    let resolveResume: () => void;
    dockerStore.resumeContainer = (_id: string) =>
      new Promise<boolean>((resolve) => {
        resolveResume = () => resolve(true);
      });

    const wrapper = mount(FolderContainer, {
      props: { folder },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });

    const card = wrapper.findComponent({ name: 'ContainerCard' });
    card.vm.$emit('resume', 'c1');
    await wrapper.vm.$nextTick();

    expect(card.text()).toContain('Resuming...');
    expect(wrapper.find('.animate-spin').exists()).toBe(true);

    resolveResume!();
    await new Promise((r) => setTimeout(r, 10));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.animate-spin').exists()).toBe(false);
  });

  it('keeps a paused container visible when "hide stopped" is on', () => {
    const containers = [
      makeContainer({ id: 'c1', name: 'running-one', state: 'running' }),
      makeContainer({ id: 'c2', name: 'paused-one', state: 'paused' }),
      makeContainer({ id: 'c3', name: 'exited-one', state: 'exited' }),
    ];
    const dockerStore = useDockerStore();
    dockerStore.containers = containers;

    localStorage.setItem('docker-folders-hide-stopped-1', '1');

    const folder = makeFolder({
      containers: [
        { id: 1, folder_id: 1, container_name: 'running-one', container_id: 'c1', position: 0 },
        { id: 2, folder_id: 1, container_name: 'paused-one', container_id: 'c2', position: 1 },
        { id: 3, folder_id: 1, container_name: 'exited-one', container_id: 'c3', position: 2 },
      ],
    });

    const wrapper = mount(FolderContainer, {
      props: { folder },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });

    const cards = wrapper.findAllComponents({ name: 'ContainerCard' });
    const names = cards.map((c) => c.props('container').name);
    expect(names).toContain('running-one');
    expect(names).toContain('paused-one');
    expect(names).not.toContain('exited-one');

    localStorage.removeItem('docker-folders-hide-stopped-1');
  });
});

describe('FolderContainer hidden-stopped count', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.setItem('docker-folders-hide-stopped-1', '1');
  });

  afterEach(() => {
    localStorage.removeItem('docker-folders-hide-stopped-1');
  });

  function hiddenCountFor(containerStates: Record<string, string>, memberNames: string[]): number {
    const dockerStore = useDockerStore();
    dockerStore.containers = Object.entries(containerStates).map(([name, state], i) =>
      makeContainer({ id: `c${i}`, name, state })
    );
    const folder = makeFolder({
      containers: memberNames.map((name, i) => ({ id: i + 1, folder_id: 1, container_name: name, container_id: `x${i}`, position: i })),
    });
    const wrapper = mount(FolderContainer, {
      props: { folder },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    return wrapper.findComponent({ name: 'FolderHeader' }).props('hiddenCount');
  }

  it('does not count a member whose container was removed from Docker', () => {
    expect(hiddenCountFor({ web: 'running', db: 'running' }, ['web', 'db', 'removed'])).toBe(0);
  });

  it('counts a stopped container that still exists', () => {
    expect(hiddenCountFor({ web: 'running', db: 'exited' }, ['web', 'db', 'removed'])).toBe(1);
  });
});

describe('FolderContainer sort order', () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  // Stored order, status order, name order, and newest-first order all differ.
  function cardNames(folderMode: Folder['sort_mode'], toolbarMode: Folder['sort_mode']): string[] {
    useDockerStore().containers = [
      makeContainer({ id: 'c1', name: 'zeta-stopped', state: 'exited', created: 200 }),
      makeContainer({ id: 'c2', name: 'alpha-running', state: 'running', created: 100 }),
      makeContainer({ id: 'c3', name: 'mid-running', state: 'running', created: 300 }),
    ];
    useSettingsStore().sortMode = toolbarMode;
    const folder = makeFolder({
      sort_mode: folderMode,
      containers: [
        { id: 1, folder_id: 1, container_name: 'zeta-stopped', container_id: 'c1', position: 0 },
        { id: 2, folder_id: 1, container_name: 'mid-running', container_id: 'c3', position: 1 },
        { id: 3, folder_id: 1, container_name: 'alpha-running', container_id: 'c2', position: 2 },
      ],
    });
    const wrapper = mount(FolderContainer, {
      props: { folder },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    return wrapper.findAllComponents({ name: 'ContainerCard' }).map((c) => c.props('container').name);
  }

  it('keeps stored order when both the folder and the toolbar are manual', () => {
    expect(cardNames('manual', 'manual')).toEqual(['zeta-stopped', 'mid-running', 'alpha-running']);
  });

  it('a manual folder follows the toolbar status sort', () => {
    expect(cardNames('manual', 'status')).toEqual(['alpha-running', 'mid-running', 'zeta-stopped']);
  });

  it('a manual folder follows the toolbar newest-first sort', () => {
    expect(cardNames('manual', 'created-desc')).toEqual(['mid-running', 'zeta-stopped', 'alpha-running']);
  });

  it("a folder's own mode overrides the toolbar sort", () => {
    expect(cardNames('name-asc', 'status')).toEqual(['alpha-running', 'mid-running', 'zeta-stopped']);
    expect(cardNames('name-desc', 'status')).toEqual(['zeta-stopped', 'mid-running', 'alpha-running']);
  });
});
