import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SelectModal from '../SelectModal.vue';

const OPTIONS = [
  { value: '1', label: 'Media' },
  { value: '2', label: 'Web' },
  { value: '', label: 'No folder' },
];

function mountSelect(props: Record<string, unknown> = {}) {
  return mount(SelectModal, {
    props: {
      isOpen: true,
      title: 'Move to Folder',
      options: OPTIONS,
      ...props,
    },
    global: { stubs: { Teleport: true } },
  });
}

describe('SelectModal', () => {
  it('renders one option per entry with the first one selected', () => {
    const wrapper = mountSelect();
    const select = wrapper.find('select');
    expect(select.exists()).toBe(true);
    expect(select.findAll('option').map((o) => o.text())).toEqual(['Media', 'Web', 'No folder']);
    expect((select.element as HTMLSelectElement).value).toBe('1');
  });

  it('emits confirm with the selected value under the given label', async () => {
    const wrapper = mountSelect({ confirmLabel: 'Move' });
    await wrapper.find('select').setValue('2');
    const confirm = wrapper.findAll('button').find((b) => b.text() === 'Move')!;
    await confirm.trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([['2']]);
  });

  it('emits cancel from the Cancel button', async () => {
    const wrapper = mountSelect();
    const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancel')!;
    await cancel.trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });
});
