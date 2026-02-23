import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import KebabMenu from '../KebabMenu.vue';
import type { KebabMenuItem } from '../KebabMenu.vue';

const linkItems: KebabMenuItem[] = [
  { label: 'Edit', icon: 'M11 4H4|M18.5 2.5', href: '/edit', show: true },
  { label: 'Logs', icon: 'M14 2H6', href: '/logs', target: '_blank', show: true },
  { label: 'Hidden', icon: 'M0 0', href: '/hidden', show: false },
];

const buttonItems: KebabMenuItem[] = [
  { label: 'Edit', icon: 'M11 4H4|M18.5 2.5', action: 'edit' },
  { label: 'Delete', icon: 'M3 6h18', action: 'delete', class: 'hover:text-error' },
];

function mountMenu(items: KebabMenuItem[], props: Record<string, unknown> = {}) {
  return mount(KebabMenu, {
    props: { items, ...props },
  });
}

describe('KebabMenu', () => {
  it('renders a kebab button', () => {
    const wrapper = mountMenu(linkItems);
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('dropdown is hidden by default', () => {
    const wrapper = mountMenu(linkItems);
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('clicking button opens the dropdown', async () => {
    const wrapper = mountMenu(linkItems);
    await wrapper.find('button').trigger('click');
    expect(wrapper.findAll('.kebab-menu-item').length).toBe(2); // Hidden item filtered out
  });

  it('filters out items with show=false', async () => {
    const wrapper = mountMenu(linkItems);
    await wrapper.find('button').trigger('click');
    const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
    expect(labels).not.toContain('Hidden');
  });

  it('renders link items as <a> tags', async () => {
    const wrapper = mountMenu(linkItems);
    await wrapper.find('button').trigger('click');
    const anchors = wrapper.findAll('a.kebab-menu-item');
    expect(anchors.length).toBe(2);
    expect(anchors[0].attributes('href')).toBe('/edit');
    expect(anchors[1].attributes('target')).toBe('_blank');
  });

  it('renders button items as <button> tags and emits select', async () => {
    const wrapper = mountMenu(buttonItems);
    await wrapper.find('button').trigger('click');
    const buttons = wrapper.findAll('button.kebab-menu-item');
    expect(buttons.length).toBe(2);

    await buttons[0].trigger('click');
    expect(wrapper.emitted('select')).toBeTruthy();
    expect(wrapper.emitted('select')![0]).toEqual(['edit']);
  });

  it('applies custom class to items', async () => {
    const wrapper = mountMenu(buttonItems);
    await wrapper.find('button').trigger('click');
    const deleteBtn = wrapper.findAll('button.kebab-menu-item')[1];
    expect(deleteBtn.classes()).toContain('hover:text-error');
  });

  it('closes on click outside', async () => {
    const wrapper = mountMenu(linkItems);
    await wrapper.find('button').trigger('click');
    expect(wrapper.findAll('.kebab-menu-item').length).toBe(2);

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('closes after clicking a link item', async () => {
    const wrapper = mountMenu(linkItems);
    await wrapper.find('button').trigger('click');
    await wrapper.find('a.kebab-menu-item').trigger('click');
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('closes after clicking a button item', async () => {
    const wrapper = mountMenu(buttonItems);
    await wrapper.find('button').trigger('click');
    await wrapper.find('button.kebab-menu-item').trigger('click');
    expect(wrapper.find('.kebab-menu-item').exists()).toBe(false);
  });

  it('positions dropdown below by default', async () => {
    const wrapper = mountMenu(linkItems);
    await wrapper.find('button').trigger('click');
    const dropdown = wrapper.findAll('div').find((d) => d.classes().includes('absolute'))!;
    expect(dropdown.classes()).toContain('top-full');
  });

  it('positions dropdown above when position="above"', async () => {
    const wrapper = mountMenu(linkItems, { position: 'above' });
    await wrapper.find('button').trigger('click');
    const dropdown = wrapper.findAll('div').find((d) => d.classes().includes('absolute'))!;
    expect(dropdown.classes()).toContain('bottom-full');
  });

  it('exposes menuOpen for parent z-index binding', async () => {
    const wrapper = mountMenu(linkItems);
    expect(wrapper.vm.menuOpen).toBe(false);
    await wrapper.find('button').trigger('click');
    expect(wrapper.vm.menuOpen).toBe(true);
  });

  it('uses custom buttonTitle', () => {
    const wrapper = mountMenu(linkItems, { buttonTitle: 'Folder actions' });
    expect(wrapper.find('button').attributes('title')).toBe('Folder actions');
  });

  it('link and button items share consistent layout classes', async () => {
    // Shared classes that must appear on both <a> and <button> menu items
    const sharedClasses = ['kebab-menu-item', 'flex', 'items-center', 'gap-2.5', 'w-full', 'px-3', 'py-2', 'text-sm', 'text-text', 'transition', 'cursor-pointer'];

    const linkWrapper = mountMenu(linkItems);
    await linkWrapper.find('button').trigger('click');
    const anchor = linkWrapper.find('a.kebab-menu-item');
    for (const cls of sharedClasses) {
      expect(anchor.classes(), `<a> missing class "${cls}"`).toContain(cls);
    }

    const buttonWrapper = mountMenu(buttonItems);
    await buttonWrapper.find('button').trigger('click');
    const btn = buttonWrapper.find('button.kebab-menu-item');
    for (const cls of sharedClasses) {
      expect(btn.classes(), `<button> missing class "${cls}"`).toContain(cls);
    }
  });
});
