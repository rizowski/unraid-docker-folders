import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
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

  describe('disabled items', () => {
    const withDisabled: KebabMenuItem[] = [
      { label: 'Stack Up', action: 'compose-up', disabled: true, title: 'Docker Compose is not installed' },
      { label: 'Rename', action: 'rename' },
    ];

    /**
     * The whole point of `disabled` over `show: false`: the item stays in the
     * menu so it does not reflow when an async capability check resolves.
     */
    it('renders a disabled item rather than removing it', async () => {
      const wrapper = mountMenu(withDisabled);
      await wrapper.find('button').trigger('click');

      const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
      expect(labels).toContain('Stack Up');
      expect(labels.length).toBe(2);
    });

    it('marks the item disabled and shows the reason as a title', async () => {
      const wrapper = mountMenu(withDisabled);
      await wrapper.find('button').trigger('click');

      const item = wrapper.findAll('button.kebab-menu-item')[0];
      expect(item.attributes('disabled')).toBeDefined();
      expect(item.attributes('title')).toBe('Docker Compose is not installed');
    });

    it('does not emit select when a disabled item is clicked', async () => {
      const wrapper = mountMenu(withDisabled);
      await wrapper.find('button').trigger('click');

      await wrapper.findAll('button.kebab-menu-item')[0].trigger('click');
      expect(wrapper.emitted('select')).toBeUndefined();
    });

    it('still emits select for enabled items alongside disabled ones', async () => {
      const wrapper = mountMenu(withDisabled);
      await wrapper.find('button').trigger('click');

      await wrapper.findAll('button.kebab-menu-item')[1].trigger('click');
      expect(wrapper.emitted('select')?.[0]).toEqual(['rename']);
    });

    it('does not mark ordinary items disabled', async () => {
      const wrapper = mountMenu(buttonItems);
      await wrapper.find('button').trigger('click');

      const item = wrapper.find('button.kebab-menu-item');
      expect(item.attributes('disabled')).toBeUndefined();
      expect(item.classes()).toContain('cursor-pointer');
    });
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

/**
 * Placement depends on real geometry, which jsdom does not do: every rect is
 * zero and scrollHeight is 0. These stubs feed the resolver plausible numbers so
 * the flip and the clamp can be exercised. The zero case is covered too — it is
 * what the production guard bails on, and what every other test in this file
 * runs under.
 */
describe('KebabMenu – fitting the viewport', () => {
  function stubGeometry(opts: { top: number; bottom: number; menuHeight: number; innerHeight: number }) {
    Object.defineProperty(window, 'innerHeight', { value: opts.innerHeight, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: opts.top,
      bottom: opts.bottom,
      left: 0,
      right: 0,
      width: 0,
      height: opts.bottom - opts.top,
      x: 0,
      y: opts.top,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      value: opts.menuHeight,
      configurable: true,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  });

  async function openMenu(props: Record<string, unknown> = {}) {
    const wrapper = mountMenu(linkItems, props);
    await wrapper.find('button').trigger('click');
    await flushPromises();
    await nextTick();
    return wrapper;
  }

  function dropdownOf(wrapper: ReturnType<typeof mountMenu>) {
    return wrapper.findAll('div').find((d) => d.classes().includes('absolute'))!;
  }

  it('keeps the preferred side and stays unclamped when the menu fits', async () => {
    stubGeometry({ top: 100, bottom: 130, menuHeight: 200, innerHeight: 768 });
    const dropdown = dropdownOf(await openMenu());

    expect(dropdown.classes()).toContain('top-full');
    expect(dropdown.attributes('style')).toBeUndefined();
  });

  it('flips above when the menu cannot fit below and there is more room above', async () => {
    // Last row of a short iframe: 2px below the button, 552px above it.
    stubGeometry({ top: 560, bottom: 590, menuHeight: 200, innerHeight: 600 });
    const dropdown = dropdownOf(await openMenu());

    expect(dropdown.classes()).toContain('bottom-full');
    expect(dropdown.classes()).not.toContain('top-full');
    expect(dropdown.attributes('style')).toBeUndefined();
  });

  it('clamps and scrolls internally when neither side can hold the menu', async () => {
    // 212px below, 142px above, menu wants 400px. Below wins on room alone.
    stubGeometry({ top: 150, bottom: 180, menuHeight: 400, innerHeight: 400 });
    const dropdown = dropdownOf(await openMenu());

    expect(dropdown.classes()).toContain('top-full');
    expect(dropdown.attributes('style')).toContain('max-height: 212px');
    expect(dropdown.attributes('style')).toContain('overflow-y: auto');
  });

  it('treats position="above" as a preference, not a guarantee', async () => {
    // Grid view pins "above", but here there are only 12px above and 710 below.
    stubGeometry({ top: 20, bottom: 50, menuHeight: 300, innerHeight: 768 });
    const dropdown = dropdownOf(await openMenu({ position: 'above' }));

    expect(dropdown.classes()).toContain('top-full');
  });

  it('leaves placement alone when there is no layout to measure', async () => {
    // scrollHeight 0 is jsdom, a display:none ancestor, or a pre-paint frame.
    stubGeometry({ top: 0, bottom: 0, menuHeight: 0, innerHeight: 768 });
    const dropdown = dropdownOf(await openMenu({ position: 'above' }));

    expect(dropdown.classes()).toContain('bottom-full');
    expect(dropdown.attributes('style')).toBeUndefined();
  });

  it('re-measures on each open rather than reusing the last result', async () => {
    stubGeometry({ top: 560, bottom: 590, menuHeight: 200, innerHeight: 600 });
    const wrapper = await openMenu();
    expect(dropdownOf(wrapper).classes()).toContain('bottom-full');

    await wrapper.find('button').trigger('click');
    vi.restoreAllMocks();
    stubGeometry({ top: 100, bottom: 130, menuHeight: 200, innerHeight: 768 });
    await wrapper.find('button').trigger('click');
    await flushPromises();
    await nextTick();

    expect(dropdownOf(wrapper).classes()).toContain('top-full');
  });
});
