import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ContainerCard from '../ContainerCard.vue';
import type { Container } from '@/stores/docker';

function makeContainer(overrides: Partial<Container> = {}): Container {
  return {
    id: 'abc123',
    name: 'test-container',
    image: 'nginx:latest',
    state: 'running',
    status: 'Up 2 hours',
    command: '/entrypoint.sh',
    ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
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

function mountCard(container?: Partial<Container>, props: Record<string, unknown> = {}) {
  return mount(ContainerCard, {
    props: {
      container: makeContainer(container),
      view: 'grid' as const,
      ...props,
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        Teleport: true,
      },
    },
  });
}

describe('ContainerCard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('menu is hidden by default', () => {
    const wrapper = mountCard();
    // The kebab dropdown should not be rendered initially
    const menuItems = wrapper.findAll('.kebab-menu-item');
    expect(menuItems.length).toBe(0);
  });

  it('clicking kebab button opens the menu (grid view)', async () => {
    const wrapper = mountCard();
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
    expect(kebab).toBeTruthy();
    await kebab.trigger('click');
    expect(wrapper.findAll('.kebab-menu-item').length).toBeGreaterThan(0);
  });

  it('shows relevant menu items for a running dockerman container', async () => {
    const wrapper = mountCard({ state: 'running', managed: 'dockerman' });
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
    await kebab.trigger('click');

    const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
    // Running dockerman container should have Edit, Console, Logs, and Project at minimum
    expect(labels).toContain('Edit');
    expect(labels).toContain('Console');
    expect(labels).toContain('Logs');
  });

  it('shows fewer menu items for exited container', async () => {
    const wrapper = mountCard({ state: 'exited', managed: 'dockerman' });
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
    await kebab.trigger('click');

    const labels = wrapper.findAll('.kebab-menu-item').map((el) => el.text().trim());
    // Exited container should still have Edit but not Console
    expect(labels).toContain('Edit');
    expect(labels).not.toContain('Console');
  });

  it('clicking outside closes the menu', async () => {
    const wrapper = mountCard();
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
    await kebab.trigger('click');
    expect(wrapper.findAll('.kebab-menu-item').length).toBeGreaterThan(0);

    // Simulate click outside
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.findAll('.kebab-menu-item').length).toBe(0);
  });

  describe('z-index stacking', () => {
    it('grid view card does not have z-50 when menu is closed', () => {
      const wrapper = mountCard({}, { view: 'grid' });
      const card = wrapper.find('.container-card-enter');
      expect(card.classes()).not.toContain('z-50');
    });

    it('grid view card gains z-50 when menu is open to elevate above siblings', async () => {
      const wrapper = mountCard({}, { view: 'grid' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
      await kebab.trigger('click');
      const card = wrapper.find('.container-card-enter');
      expect(card.classes()).toContain('z-50');
    });

    it('list view card gains z-50 when menu is open to elevate above siblings', async () => {
      const wrapper = mountCard({}, { view: 'list' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
      await kebab.trigger('click');
      const card = wrapper.find('.container-card-enter');
      expect(card.classes()).toContain('z-50');
    });

    it('grid view card loses z-50 when menu closes', async () => {
      const wrapper = mountCard({}, { view: 'grid' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
      await kebab.trigger('click');
      expect(wrapper.find('.container-card-enter').classes()).toContain('z-50');

      // Close via click outside
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wrapper.vm.$nextTick();
      expect(wrapper.find('.container-card-enter').classes()).not.toContain('z-50');
    });

    it('grid view kebab dropdown uses z-[100]', async () => {
      const wrapper = mountCard({}, { view: 'grid' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
      await kebab.trigger('click');

      const dropdown = wrapper.findAll('div').find((d) =>
        d.classes().some((c) => c.includes('z-[100]')) && d.classes().includes('absolute')
      );
      expect(dropdown).toBeTruthy();
    });

    it('list view kebab dropdown uses z-[100]', async () => {
      const wrapper = mountCard({}, { view: 'list' });
      const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
      await kebab.trigger('click');

      const dropdown = wrapper.findAll('div').find((d) =>
        d.classes().some((c) => c.includes('z-[100]')) && d.classes().includes('absolute')
      );
      expect(dropdown).toBeTruthy();
    });
  });

  it('menu works in list view', async () => {
    const wrapper = mountCard({}, { view: 'list' });
    const kebab = wrapper.findAll('button').find((b) => b.attributes('title') === 'More actions')!;
    expect(kebab).toBeTruthy();
    await kebab.trigger('click');
    expect(wrapper.findAll('.kebab-menu-item').length).toBeGreaterThan(0);
  });

  it('list view row does not use overflow-hidden so dropdown is not clipped', () => {
    const wrapper = mountCard({}, { view: 'list' });
    const row = wrapper.find('.container-row');
    expect(row.classes()).not.toContain('overflow-hidden');
  });

  describe('action loading states', () => {
    it('shows spinner and status text when actionInProgress is set (grid)', () => {
      const wrapper = mountCard({}, { actionInProgress: 'stop' });
      expect(wrapper.find('.animate-spin').exists()).toBe(true);
      expect(wrapper.text()).toContain('Stopping...');
    });

    it('shows spinner and status text when actionInProgress is set (list)', () => {
      const wrapper = mountCard({}, { actionInProgress: 'restart', view: 'list' });
      expect(wrapper.find('.animate-spin').exists()).toBe(true);
      expect(wrapper.text()).toContain('Restarting...');
    });

    it('hides action buttons when actionInProgress is set (grid)', () => {
      const wrapper = mountCard({ state: 'running' }, { actionInProgress: 'stop' });
      const stopBtn = wrapper.findAll('button').find((b) => b.attributes('title') === 'Stop');
      expect(stopBtn).toBeUndefined();
    });

    it('hides action buttons when actionInProgress is set (list)', () => {
      const wrapper = mountCard({ state: 'running' }, { actionInProgress: 'stop', view: 'list' });
      const stopBtn = wrapper.findAll('button').find((b) => b.attributes('title') === 'Stop');
      expect(stopBtn).toBeUndefined();
    });

    it('shows action buttons when actionInProgress is null', () => {
      const wrapper = mountCard({ state: 'running' }, { actionInProgress: null });
      const stopBtn = wrapper.findAll('button').find((b) => b.attributes('title') === 'Stop');
      expect(stopBtn).toBeTruthy();
    });

    it('displays correct text for each action type', () => {
      const actions = [
        { action: 'start', text: 'Starting...' },
        { action: 'stop', text: 'Stopping...' },
        { action: 'restart', text: 'Restarting...' },
        { action: 'remove', text: 'Removing...' },
      ];
      for (const { action, text } of actions) {
        const wrapper = mountCard({}, { actionInProgress: action });
        expect(wrapper.text()).toContain(text);
      }
    });
  });
});
