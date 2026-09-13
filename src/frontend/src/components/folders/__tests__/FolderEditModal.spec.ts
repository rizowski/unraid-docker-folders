import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import FolderEditModal from '../FolderEditModal.vue';
import { useDockerStore } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { makeContainer } from '@/test/fixtures';
import type { Folder, ContainerAssociation, FolderContainerSelection } from '@/types/folder';

// The modal never talks to the API itself, but the stores it reads do.
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

function assoc(name: string, position: number): ContainerAssociation {
  return {
    id: position + 1,
    container_id: `id-${name}`,
    container_name: name,
    folder_id: 1,
    position,
  };
}

function makeFolder(containerNames: string[], overrides: Partial<Folder> = {}): Folder {
  return {
    id: 1,
    name: 'Media',
    icon: null,
    color: '#ff8c2f',
    position: 0,
    collapsed: false,
    compose_project: null,
    created_at: 0,
    updated_at: 0,
    containers: containerNames.map((n, i) => assoc(n, i)),
    ...overrides,
  };
}

// The component must share the pinia the test writes to.
let pinia: Pinia;
// BaseModal teleports to this id, so it has to exist in the document.
let target: HTMLElement;

function mountModal(folder: Folder | null) {
  return mount(FolderEditModal, {
    props: { isOpen: true, folder },
    global: { plugins: [pinia] },
  });
}

/** Checkbox rows live in the teleport target, not under the wrapper element. */
function rows() {
  return Array.from(target.querySelectorAll('label')).filter((l) =>
    l.querySelector('input[type="checkbox"]'),
  );
}

function rowNames() {
  return rows().map((l) => l.querySelector('span')!.textContent!.trim());
}

function checkedNames() {
  return rows()
    .filter((l) => (l.querySelector('input[type="checkbox"]') as HTMLInputElement).checked)
    .map((l) => l.querySelector('span')!.textContent!.trim());
}

function savedContainers(wrapper: ReturnType<typeof mountModal>) {
  const events = wrapper.emitted('save');
  expect(events).toBeTruthy();
  return events![events!.length - 1][1] as FolderContainerSelection[] | null;
}

async function submit() {
  target.querySelector('form')!.dispatchEvent(new Event('submit'));
  await nextTick();
}

describe('FolderEditModal – container selection', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    target = document.createElement('div');
    target.id = 'unraid-docker-folders-modern';
    document.body.appendChild(target);
  });

  afterEach(() => {
    target.remove();
  });

  function seedStores(folder: Folder | null, containerNames: string[]) {
    useDockerStore().containers = containerNames.map((n) =>
      makeContainer({ id: `id-${n}`, name: n }),
    );
    useFolderStore().folders = folder ? [folder] : [];
  }

  it("pre-checks the folder's current members", async () => {
    const folder = makeFolder(['plex', 'sonarr']);
    seedStores(folder, ['plex', 'sonarr', 'bazarr']);
    mountModal(folder);
    await nextTick();

    expect(checkedNames().sort()).toEqual(['plex', 'sonarr']);
  });

  it('lists the folder members first in stored order, then the unfoldered ones', async () => {
    // Stored order is plex, sonarr. sortedContainers would put the exited
    // container (bazarr) first, so this also proves the state sort is overridden.
    const folder = makeFolder(['plex', 'sonarr']);
    useDockerStore().containers = [
      makeContainer({ id: 'id-bazarr', name: 'bazarr', state: 'exited' }),
      makeContainer({ id: 'id-sonarr', name: 'sonarr' }),
      makeContainer({ id: 'id-plex', name: 'plex' }),
    ];
    useFolderStore().folders = [folder];
    mountModal(folder);
    await nextTick();

    expect(rowNames()).toEqual(['plex', 'sonarr', 'bazarr']);
  });

  it('submitting without touching anything emits exactly the current members', async () => {
    const folder = makeFolder(['plex', 'sonarr']);
    seedStores(folder, ['plex', 'sonarr', 'bazarr']);
    const wrapper = mountModal(folder);
    await nextTick();

    await submit();

    expect(savedContainers(wrapper)).toEqual([
      { id: 'id-plex', name: 'plex' },
      { id: 'id-sonarr', name: 'sonarr' },
    ]);
  });

  it('unchecking a member drops it from the emitted set', async () => {
    const folder = makeFolder(['plex', 'sonarr']);
    seedStores(folder, ['plex', 'sonarr']);
    const wrapper = mountModal(folder);
    await nextTick();

    const sonarrRow = rows().find((l) => l.textContent!.includes('sonarr'))!;
    sonarrRow.querySelector('input')!.dispatchEvent(new Event('change'));
    await nextTick();

    await submit();

    expect(savedContainers(wrapper)).toEqual([{ id: 'id-plex', name: 'plex' }]);
  });

  it('checking an unfoldered container adds it to the emitted set', async () => {
    const folder = makeFolder(['plex']);
    seedStores(folder, ['plex', 'bazarr']);
    const wrapper = mountModal(folder);
    await nextTick();

    const bazarrRow = rows().find((l) => l.textContent!.includes('bazarr'))!;
    bazarrRow.querySelector('input')!.dispatchEvent(new Event('change'));
    await nextTick();

    await submit();

    expect(savedContainers(wrapper)).toEqual([
      { id: 'id-plex', name: 'plex' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);
  });

  it('emits null when the picker was never rendered', async () => {
    const folder = makeFolder([]);
    seedStores(folder, []);
    const wrapper = mountModal(folder);
    await nextTick();

    expect(rows()).toHaveLength(0);
    await submit();

    expect(savedContainers(wrapper)).toBeNull();
  });

  it('preserves a member Docker is not currently reporting', async () => {
    // 'ghost' is in the folder but absent from the docker list, so it can never
    // be rendered as a checkbox. It must still survive the save.
    const folder = makeFolder(['plex', 'ghost']);
    seedStores(folder, ['plex']);
    const wrapper = mountModal(folder);
    await nextTick();

    expect(rowNames()).toEqual(['plex']);
    await submit();

    expect(savedContainers(wrapper)).toEqual([
      { id: 'id-plex', name: 'plex' },
      { id: 'id-ghost', name: 'ghost' },
    ]);
  });

  it('checks members that arrive after the modal has opened', async () => {
    // The watch only fires on [isOpen, folder]. A selection seeded eagerly would
    // stay empty here, and every member would then be saved as a removal.
    const folder = makeFolder(['plex', 'sonarr']);
    seedStores(folder, []);
    const wrapper = mountModal(folder);
    await nextTick();
    expect(rows()).toHaveLength(0);

    useDockerStore().containers = ['plex', 'sonarr', 'bazarr'].map((n) =>
      makeContainer({ id: `id-${n}`, name: n }),
    );
    await nextTick();

    expect(checkedNames().sort()).toEqual(['plex', 'sonarr']);

    await submit();
    expect(savedContainers(wrapper)).toEqual([
      { id: 'id-plex', name: 'plex' },
      { id: 'id-sonarr', name: 'sonarr' },
    ]);
  });
});

/**
 * On Unraid the modal is rendered by the parent window, not by BaseModal, and
 * the save payload arrives as a postMessage. The host's collectValues() only
 * reports fields it actually rendered, so a save can legitimately arrive with no
 * `containers` key at all — that must mean "leave associations alone", never
 * "remove everything".
 */
describe('FolderEditModal – parent-window (iframe) save path', () => {
  let parentPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    target = document.createElement('div');
    target.id = 'unraid-docker-folders-modern';
    document.body.appendChild(target);

    // useParentModal only listens for messages when window.parent !== window.
    parentPostMessage = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: parentPostMessage },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    target.remove();
    Object.defineProperty(window, 'parent', { value: window, configurable: true, writable: true });
  });

  /** The id useParentModal generated, taken from the open() it posted upward. */
  function openedModalId(): string {
    const open = parentPostMessage.mock.calls.find((c) => c[0]?.type === 'docker-folders-modal');
    expect(open).toBeTruthy();
    return open![0].modal.id;
  }

  async function hostSaves(values: Record<string, unknown>) {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'docker-folders-modal-action',
          id: openedModalId(),
          actionId: 'save',
          values,
        },
      }),
    );
    await nextTick();
  }

  it('treats an absent containers key as "do not touch associations"', async () => {
    const folder = makeFolder(['plex', 'sonarr']);
    useDockerStore().containers = [];
    useFolderStore().folders = [folder];
    const wrapper = mountModal(folder);
    await nextTick();

    // No `containers` key: the host never rendered the picker.
    await hostSaves({ name: 'Media', color: '#ff8c2f' });

    expect(savedContainers(wrapper)).toBeNull();
  });

  it('maps the checked ids back to the desired membership set', async () => {
    const folder = makeFolder(['plex', 'sonarr']);
    useDockerStore().containers = ['plex', 'sonarr', 'bazarr'].map((n) =>
      makeContainer({ id: `id-${n}`, name: n }),
    );
    useFolderStore().folders = [folder];
    const wrapper = mountModal(folder);
    await nextTick();

    // sonarr unchecked, bazarr newly checked.
    await hostSaves({ name: 'Media', color: '#ff8c2f', containers: ['id-plex', 'id-bazarr'] });

    expect(savedContainers(wrapper)).toEqual([
      { id: 'id-plex', name: 'plex' },
      { id: 'id-bazarr', name: 'bazarr' },
    ]);
  });

  it('an empty containers array means remove every container', async () => {
    const folder = makeFolder(['plex']);
    useDockerStore().containers = [makeContainer({ id: 'id-plex', name: 'plex' })];
    useFolderStore().folders = [folder];
    const wrapper = mountModal(folder);
    await nextTick();

    await hostSaves({ name: 'Media', color: '#ff8c2f', containers: [] });

    expect(savedContainers(wrapper)).toEqual([]);
  });
});
