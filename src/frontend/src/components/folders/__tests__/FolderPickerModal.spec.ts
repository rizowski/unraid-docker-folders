import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FolderPickerModal from '../FolderPickerModal.vue';

const OPTIONS = [
  { value: '1', label: 'Media' },
  { value: '2', label: 'Web' },
  { value: '', label: 'No folder' },
];

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(FolderPickerModal, {
    props: {
      isOpen: true,
      title: 'Move to Folder',
      options: OPTIONS,
      initialValue: '1',
      ...props,
    },
    global: { stubs: { Teleport: true } },
  });
}

describe('FolderPickerModal', () => {
  it('renders one option per folder with the initial value selected', () => {
    const wrapper = mountPicker();
    const select = wrapper.find('select');
    expect(select.exists()).toBe(true);
    expect(select.findAll('option').map((o) => o.text())).toEqual(['Media', 'Web', 'No folder']);
    expect((select.element as HTMLSelectElement).value).toBe('1');
  });

  it('emits confirm with the selected value', async () => {
    const wrapper = mountPicker();
    await wrapper.find('select').setValue('2');
    const confirm = wrapper.findAll('button').find((b) => b.text() === 'Move')!;
    await confirm.trigger('click');
    expect(wrapper.emitted('confirm')).toEqual([['2']]);
  });

  it('emits cancel from the Cancel button', async () => {
    const wrapper = mountPicker();
    const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancel')!;
    await cancel.trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('uses the confirm label it is given', () => {
    const wrapper = mountPicker({ confirmLabel: 'Add' });
    expect(wrapper.findAll('button').some((b) => b.text() === 'Add')).toBe(true);
  });
});
