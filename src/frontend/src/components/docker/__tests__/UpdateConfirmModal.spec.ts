import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import UpdateConfirmModal from '../UpdateConfirmModal.vue';
import { makeContainer } from '@/test/fixtures';
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

function mountModal(units: UpdateUnit[]) {
  return mount(UpdateConfirmModal, {
    props: { isOpen: true, units },
    global: {
      plugins: [createPinia()],
      stubs: { Teleport: true },
    },
  });
}

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
