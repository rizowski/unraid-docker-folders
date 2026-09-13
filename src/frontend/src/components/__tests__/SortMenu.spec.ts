import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SortMenu from '../SortMenu.vue';
import { SORT_MODE_OPTIONS } from '@/types/folder';

describe('SortMenu', () => {
  it('menu is hidden by default', () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'manual' } });
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('clicking the button opens one row per sort mode', async () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'manual' } });
    await wrapper.find('button').trigger('click');
    const rows = wrapper.findAll('.kebab-menu-item');
    expect(rows.map((r) => r.text().trim())).toEqual(SORT_MODE_OPTIONS.map((o) => o.label));
  });

  it('marks only the active mode as checked', async () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'name-desc' } });
    await wrapper.find('button').trigger('click');
    const checked = wrapper.findAll('[aria-checked="true"]');
    expect(checked.length).toBe(1);
    expect(checked[0].text()).toBe('Name (Z → A)');
  });

  it('selecting a row emits update:modelValue and closes the menu', async () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'manual' } });
    await wrapper.find('button').trigger('click');
    const row = wrapper.findAll('.kebab-menu-item').find((r) => r.text() === 'Newest first')!;
    await row.trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([['created-desc']]);
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
  });

  it('Escape closes the menu', async () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'manual' }, attachTo: document.body });
    await wrapper.find('button').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('a click outside closes the menu', async () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'manual' }, attachTo: document.body });
    await wrapper.find('button').trigger('click');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('the trigger shows the active mode icon and names the mode', () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'status' } });
    const trigger = wrapper.find('button');
    const status = SORT_MODE_OPTIONS.find((o) => o.value === 'status')!;
    expect(trigger.attributes('title')).toBe(`Sort: ${status.label}`);
    expect(trigger.findAll('svg')[0].findAll('path').map((p) => p.attributes('d'))).toEqual(status.icon.split('|'));
  });

  it('each row shows its own mode icon', async () => {
    const wrapper = mount(SortMenu, { props: { modelValue: 'manual' } });
    await wrapper.find('button').trigger('click');
    const rows = wrapper.findAll('.kebab-menu-item');
    rows.forEach((row, i) => {
      expect(row.findAll('svg')[0].findAll('path').map((p) => p.attributes('d'))).toEqual(SORT_MODE_OPTIONS[i].icon.split('|'));
    });
  });
});
