import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import UpdateConfirmModal from '../UpdateConfirmModal.vue';
import { makeContainer, makeReleaseStatus } from '@/test/fixtures';
import { useUpdatesStore, type ImageUpdateStatus } from '@/stores/updates';
import type { UpdateUnit } from '@/utils/updateUnits';

function imageUnit(image: string, names: string[]): UpdateUnit {
  return {
    kind: 'image',
    id: `image:${image}`,
    image,
    containers: names.map((name) => makeContainer({ id: `id-${name}`, name, image })),
  };
}

function composeUnit(project: string, names: string[]): UpdateUnit {
  return {
    kind: 'compose',
    id: `compose:${project}`,
    project,
    containers: names.map((name) => makeContainer({ id: `id-${name}`, name })),
  };
}

function mountModal(
  units: UpdateUnit[],
  updates: Record<string, ImageUpdateStatus> = {},
  extraProps: { canRecheck?: boolean; checking?: boolean } = {},
) {
  // The component resolves its store from the app-level pinia, so seed that
  // one rather than whatever setActivePinia left behind.
  const pinia = createPinia();
  setActivePinia(pinia);
  useUpdatesStore().updates = updates;

  return mount(UpdateConfirmModal, {
    props: { isOpen: true, units, ...extraProps },
    global: {
      plugins: [pinia],
      stubs: { Teleport: true },
    },
  });
}

const buttonNamed = (wrapper: ReturnType<typeof mountModal>, label: string) =>
  wrapper.findAll('button').find((b) => b.text().trim() === label);

const releaseStatus = (
  image: string,
  repo: string,
  tag: string,
  summary: string,
  updateAvailable = true,
): ImageUpdateStatus =>
  makeReleaseStatus(image, repo, tag, summary, { update_available: updateAvailable });

describe('UpdateConfirmModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('lists every container that will be touched, not just the flagged one', () => {
    const wrapper = mountModal([imageUnit('nginx:latest', ['web', 'web-2'])]);

    expect(wrapper.text()).toContain('web, web-2');
    expect(wrapper.text()).toContain('nginx:latest');
    expect(wrapper.text()).toContain('2 containers will be updated.');
  });

  it('counts containers across units, not units', () => {
    const wrapper = mountModal([
      composeUnit('blog', ['blog-web', 'blog-db']),
      imageUnit('plex:latest', ['plex']),
    ]);

    expect(wrapper.text()).toContain('3 containers will be updated.');
  });

  it('uses singular phrasing for one container', () => {
    const wrapper = mountModal([imageUnit('plex:latest', ['plex'])]);
    expect(wrapper.text()).toContain('1 container will be updated.');
  });

  it('marks compose units as stacks', () => {
    const wrapper = mountModal([composeUnit('blog', ['blog-web'])]);
    expect(wrapper.text()).toContain('stack');
  });

  it('starts with every unit checked and confirms all of them', async () => {
    const units = [imageUnit('a:latest', ['a']), imageUnit('b:latest', ['b'])];
    const wrapper = mountModal(units);

    const boxes = wrapper.findAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes.every((c) => c.element.checked)).toBe(true);

    await wrapper.findAll('button')[1].trigger('click'); // Update
    expect(wrapper.emitted('confirm')?.[0][0]).toEqual(units);
  });

  it('excludes unchecked units from the confirmed set', async () => {
    const units = [imageUnit('a:latest', ['a']), imageUnit('b:latest', ['b'])];
    const wrapper = mountModal(units);

    await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
    await wrapper.findAll('button')[1].trigger('click');

    expect(wrapper.emitted('confirm')?.[0][0]).toEqual([units[1]]);
  });

  it('does not confirm when everything is unchecked', async () => {
    const wrapper = mountModal([imageUnit('a:latest', ['a'])]);

    await wrapper.findAll('input[type="checkbox"]')[0].setValue(false);
    await wrapper.findAll('button')[1].trigger('click');

    expect(wrapper.emitted('confirm')).toBeFalsy();
  });

  it('emits cancel without confirming', async () => {
    const wrapper = mountModal([imageUnit('a:latest', ['a'])]);

    await wrapper.findAll('button')[0].trigger('click'); // Cancel
    expect(wrapper.emitted('cancel')).toBeTruthy();
    expect(wrapper.emitted('confirm')).toBeFalsy();
  });
});

describe('UpdateConfirmModal – release notes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('shows the cached release notes for a unit', () => {
    const wrapper = mountModal([imageUnit('nginx:latest', ['web'])], {
      'nginx:latest': releaseStatus('nginx:latest', 'nginx/nginx', 'v1.27.0', 'HTTP/3 is stable.'),
    });

    expect(wrapper.text()).toContain('v1.27.0 — HTTP/3 is stable.');
  });

  it('renders no notes line when nothing is cached', () => {
    const wrapper = mountModal([imageUnit('nginx:latest', ['web'])]);

    // Just the two existing lines: container names and the image reference.
    expect(wrapper.findAll('label span.block')).toHaveLength(2);
  });

  it('omits notes for containers that are not flagged for an update', () => {
    const unit = composeUnit('blog', ['blog-web', 'blog-db']);
    unit.containers[0].image = 'nginx:latest';
    unit.containers[1].image = 'postgres:16';

    const wrapper = mountModal([unit], {
      'nginx:latest': releaseStatus('nginx:latest', 'nginx/nginx', 'v1.27.0', 'HTTP/3 is stable.'),
      'postgres:16': releaseStatus('postgres:16', 'postgres/postgres', 'REL_16_4', 'Nope.', false),
    });

    expect(wrapper.text()).toContain('v1.27.0 — HTTP/3 is stable.');
    expect(wrapper.text()).not.toContain('Nope.');
  });
});

describe('UpdateConfirmModal – release links', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('links a single-release row to its release page', () => {
    const wrapper = mountModal([imageUnit('nginx:latest', ['web'])], {
      'nginx:latest': releaseStatus('nginx:latest', 'nginx/nginx', 'v1.27.0', 'HTTP/3 is stable.'),
    });

    const link = wrapper.get('a[title="View release notes"]');
    expect(link.attributes('href')).toBe('https://github.com/nginx/nginx/releases/tag/v1.27.0');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
  });

  it('renders no link when a unit pulls several images', () => {
    const unit = composeUnit('blog', ['blog-web', 'blog-db']);
    unit.containers[0].image = 'nginx:latest';
    unit.containers[1].image = 'postgres:16';

    const wrapper = mountModal([unit], {
      'nginx:latest': releaseStatus('nginx:latest', 'nginx/nginx', 'v1.27.0', 'HTTP/3.'),
      'postgres:16': releaseStatus('postgres:16', 'postgres/postgres', 'REL_16_4', 'Planner fix.'),
    });

    expect(wrapper.text()).toContain('nginx v1.27.0 · postgres REL_16_4');
    expect(wrapper.find('a[title="View release notes"]').exists()).toBe(false);
  });

  it('renders no link when there are no notes at all', () => {
    const wrapper = mountModal([imageUnit('nginx:latest', ['web'])]);
    expect(wrapper.find('a[title="View release notes"]').exists()).toBe(false);
  });

  it('does not toggle the checkbox when the link is clicked', async () => {
    const wrapper = mountModal([imageUnit('nginx:latest', ['web'])], {
      'nginx:latest': releaseStatus('nginx:latest', 'nginx/nginx', 'v1.27.0', 'HTTP/3 is stable.'),
    });

    const box = wrapper.get<HTMLInputElement>('input[type="checkbox"]');
    expect(box.element.checked).toBe(true);

    await wrapper.get('a[title="View release notes"]').trigger('click');

    expect(box.element.checked).toBe(true);
  });

  describe('Check Again', () => {
    it('is absent unless the modal covers every container', () => {
      const wrapper = mountModal([imageUnit('nginx:latest', ['web'])]);
      expect(buttonNamed(wrapper, 'Check Again')).toBeUndefined();
    });

    it('is offered when the modal was opened from the header', () => {
      const wrapper = mountModal([imageUnit('nginx:latest', ['web'])], {}, { canRecheck: true });
      expect(buttonNamed(wrapper, 'Check Again')).toBeTruthy();
    });

    it('emits recheck rather than cancelling', async () => {
      const wrapper = mountModal([imageUnit('nginx:latest', ['web'])], {}, { canRecheck: true });

      await buttonNamed(wrapper, 'Check Again')!.trigger('click');

      expect(wrapper.emitted('recheck')).toBeTruthy();
      expect(wrapper.emitted('cancel')).toBeFalsy();
    });

    /**
     * A check takes seconds against a registry. Updating from a list that is
     * mid-refresh would act on rows about to be replaced.
     */
    it('locks the footer while the check runs', () => {
      const wrapper = mountModal(
        [imageUnit('nginx:latest', ['web'])],
        {},
        { canRecheck: true, checking: true },
      );

      expect(buttonNamed(wrapper, 'Checking…')!.attributes('disabled')).toBeDefined();
      expect(buttonNamed(wrapper, 'Update')!.attributes('disabled')).toBeDefined();
      expect(buttonNamed(wrapper, 'Cancel')!.attributes('disabled')).toBeDefined();
    });
  });

  describe('when a re-check clears every update', () => {
    /**
     * The modal stays open on an empty list instead of vanishing, so clicking
     * "Check Again" has a visible result either way.
     */
    it('shows an up-to-date message instead of an empty list', () => {
      const wrapper = mountModal([], {}, { canRecheck: true });

      expect(wrapper.text()).toContain('Everything is up to date.');
      expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    });

    it('offers only Close', () => {
      const wrapper = mountModal([], {}, { canRecheck: true });

      expect(buttonNamed(wrapper, 'Close')).toBeTruthy();
      expect(buttonNamed(wrapper, 'Update')).toBeUndefined();
      expect(buttonNamed(wrapper, 'Check Again')).toBeUndefined();
    });

    it('Close dismisses the modal', async () => {
      const wrapper = mountModal([], {}, { canRecheck: true });

      await buttonNamed(wrapper, 'Close')!.trigger('click');

      expect(wrapper.emitted('cancel')).toBeTruthy();
    });
  });
});
