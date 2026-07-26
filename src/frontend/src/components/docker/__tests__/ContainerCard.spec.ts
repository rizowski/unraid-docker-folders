import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ContainerCard from '../ContainerCard.vue';
import { useDockerStore, type Container } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { makeContainer as baseContainer } from '@/test/fixtures';

// This suite's default container publishes a port — several tests assert on the
// rendered port summary — so it layers that onto the shared fixture.
function makeContainer(overrides: Partial<Container> = {}): Container {
  return baseContainer({
    ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
    ...overrides,
  });
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

  describe('status halo on the container icon', () => {
    // The halo sits on the span wrapping the icon, not the img itself.
    const iconClasses = (w: ReturnType<typeof mount>) =>
      w.find('img').element.parentElement!.className.split(' ');

    it('marks a healthy running container with a success halo (grid)', () => {
      expect(iconClasses(mountCard({ status: 'Up 2 hours (healthy)' }))).toContain('status-halo-success');
    });

    it('marks a running container with no health check as info (grid)', () => {
      expect(iconClasses(mountCard({ status: 'Up 2 hours' }))).toContain('status-halo-info');
    });

    it('marks a stopped container with an error halo (list)', () => {
      const wrapper = mountCard({ state: 'exited', status: 'Exited (0) 3 hours ago' }, { view: 'list' });
      expect(iconClasses(wrapper)).toContain('status-halo-error');
    });

    it('falls back to success for running containers when distinguishHealthy is off', () => {
      const wrapper = mount(ContainerCard, {
        props: { container: makeContainer({ status: 'Up 2 hours' }), view: 'grid' as const },
        global: {
          plugins: [createPinia()],
          provide: { distinguishHealthy: ref(false) },
          stubs: { Teleport: true },
        },
      });
      expect(iconClasses(wrapper)).toContain('status-halo-success');
    });
  });

  describe('container icon links to the WebUI', () => {
    const iconEl = (w: ReturnType<typeof mount>) => w.find('img').element.parentElement!;
    const isExpanded = (w: ReturnType<typeof mount>) => w.text().includes('Resource Usage');

    for (const view of ['grid', 'list'] as const) {
      it(`renders the icon as a link with the resolved URL (${view})`, () => {
        const wrapper = mountCard(
          { webui: 'http://[IP]:[PORT:80]/admin', state: 'running' },
          { view },
        );
        const icon = iconEl(wrapper);

        expect(icon.tagName).toBe('A');
        // [IP] -> hostname, [PORT:80] -> the mapped public port 8080
        expect(icon.getAttribute('href')).toBe(`http://${window.location.hostname}:8080/admin`);
        expect(icon.getAttribute('target')).toBe('_blank');
        expect(icon.getAttribute('rel')).toBe('noopener noreferrer');
        expect(icon.getAttribute('title')).toContain('Open WebUI');
      });

      it(`clicking the icon opens the WebUI without expanding the card (${view})`, async () => {
        const wrapper = mountCard(
          { webui: 'http://[IP]:[PORT:80]/admin', state: 'running' },
          { view },
        );
        expect(isExpanded(wrapper)).toBe(false);

        await wrapper.find('img').trigger('click');

        expect(isExpanded(wrapper)).toBe(false);
      });

      it(`stays an inert span and still expands when there is no WebUI (${view})`, async () => {
        const wrapper = mountCard({ webui: null, state: 'running' }, { view });
        expect(iconEl(wrapper).tagName).toBe('SPAN');

        await wrapper.find('img').trigger('click');

        expect(isExpanded(wrapper)).toBe(true);
      });
    }

    it('does not link when the container is stopped', () => {
      const wrapper = mountCard({
        webui: 'http://[IP]:[PORT:80]/admin',
        state: 'exited',
        status: 'Exited (0) 3 hours ago',
      });
      expect(iconEl(wrapper).tagName).toBe('SPAN');
    });
  });

  describe('expand click target (grid view)', () => {
    const isExpanded = (w: ReturnType<typeof mountCard>) => w.text().includes('Resource Usage');

    it('expands when the title header is clicked, not just the chevron row', async () => {
      const wrapper = mountCard();
      expect(isExpanded(wrapper)).toBe(false);

      const title = wrapper.find('h3');
      expect(title.text()).toBe('test-container');
      await title.trigger('click');

      expect(isExpanded(wrapper)).toBe(true);
    });

    it('does not expand when a footer action button is clicked', async () => {
      const wrapper = mountCard({ state: 'running' });

      const restart = wrapper.findAll('button').find((b) => b.attributes('title') === 'Restart')!;
      expect(restart).toBeTruthy();
      await restart.trigger('click');

      expect(isExpanded(wrapper)).toBe(false);
    });
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

  describe('inline logs panel', () => {
    const MOCK_LOGS = '2026-02-28T10:00:00Z [info] server started\n2026-02-28T10:01:00Z [info] ready';

    const FAKE_STATS = {
      cpuPercent: 5,
      memoryUsage: 1024 * 1024 * 100,
      memoryLimit: 1024 * 1024 * 1024,
      memoryPercent: 10,
      blockRead: 0,
      blockWrite: 0,
      netRx: 0,
      netTx: 0,
      pids: 4,
      restartCount: 0,
      startedAt: new Date().toISOString(),
      imageSize: 1024 * 1024 * 200,
      logSize: 1024 * 50,
    };

    /**
     * Mount a card that shares a single pinia with the test so we can
     * pre-configure settings and stats stores before the component reads them.
     */
    function mountCardWithSharedPinia(
      container: Partial<Container>,
      props: Record<string, unknown>,
      opts: { enableLogs?: boolean; seedStatsId?: string } = {},
    ) {
      const pinia = createPinia();
      setActivePinia(pinia);

      // Configure stores on the shared pinia BEFORE mounting
      const settingsStore = useSettingsStore();
      if (opts.enableLogs) {
        settingsStore.showInlineLogs = true;
      }

      if (opts.seedStatsId) {
        const statsStore = useStatsStore();
        statsStore.stats[opts.seedStatsId] = { ...FAKE_STATS };
      }

      return mount(ContainerCard, {
        props: {
          container: makeContainer(container),
          view: 'grid' as const,
          ...props,
        },
        global: {
          plugins: [pinia],
          stubs: { Teleport: true },
        },
      });
    }

    /** Mount a list-view card, expand it, and optionally enable inline logs */
    async function mountExpandedListCard(
      opts: { enableLogs?: boolean; containerOverrides?: Partial<Container> } = {},
    ) {
      const { enableLogs = false, containerOverrides = {} } = opts;
      const containerId = containerOverrides.id ?? 'abc123';

      const wrapper = mountCardWithSharedPinia(
        { state: 'running', ...containerOverrides },
        { view: 'list' },
        { enableLogs, seedStatsId: containerId },
      );

      // Expand the card by clicking the row
      const row = wrapper.find('.container-row > div');
      await row.trigger('click');
      await flushPromises();

      return wrapper;
    }

    /** Count how many fetch calls targeted the logs endpoint */
    function logsCallCount() {
      return fetchSpy.mock.calls.filter(
        (call: unknown[]) => {
          const input = call[0];
          const url = typeof input === 'string' ? input : (input as Request).url;
          return url.includes('action=logs');
        },
      ).length;
    }

    /** Find the first fetch call targeting the logs endpoint */
    function findLogsCall() {
      return fetchSpy.mock.calls.find(
        (call: unknown[]) => {
          const input = call[0];
          const url = typeof input === 'string' ? input : (input as Request).url;
          return url.includes('action=logs');
        },
      );
    }

    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Mock global fetch to return fake logs for the logs endpoint
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('action=logs')) {
          return new Response(JSON.stringify({ logs: MOCK_LOGS }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Return empty/error for other fetch calls (stats, etc.)
        return new Response(JSON.stringify({}), { status: 200 });
      });
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('does not show log panel when showInlineLogs setting is off', async () => {
      const wrapper = await mountExpandedListCard({ enableLogs: false });

      expect(wrapper.text()).toContain('Resource Usage');
      expect(wrapper.text()).not.toContain('Loading logs...');
      // No "Logs" label in the stats section (the kebab menu "Logs" item is separate)
      const logsHeaders = wrapper.findAll('p').filter((p) => p.text() === 'Logs');
      expect(logsHeaders.length).toBe(0);
    });

    it('does not show log panel in grid view even when setting is on', async () => {
      const wrapper = mountCardWithSharedPinia(
        { state: 'running' },
        { view: 'grid' },
        { enableLogs: true, seedStatsId: 'abc123' },
      );

      // Expand grid card
      const summary = wrapper.find('.cursor-pointer');
      await summary.trigger('click');
      await flushPromises();

      // Should not have the inline log panel
      const refreshBtn = wrapper.findAll('button').find((b) => b.attributes('title') === 'Refresh logs');
      expect(refreshBtn).toBeUndefined();
    });

    it('shows log panel with fetched logs when setting is on in list view', async () => {
      const wrapper = await mountExpandedListCard({ enableLogs: true });

      // The logs endpoint should have been called
      expect(logsCallCount()).toBeGreaterThan(0);

      // The log content should be rendered
      expect(wrapper.text()).toContain('server started');
      expect(wrapper.text()).toContain('ready');
    });

    it('surfaces the API error instead of the empty-state text', async () => {
      // Docker refuses to serve logs (e.g. --log-driver=none): the API answers
      // 200 with an explicit reason, which must not look like "container is quiet".
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('action=logs')) {
          return new Response(
            JSON.stringify({
              logs: '',
              error: true,
              message: "Docker API HTTP 400 — this container's logging driver may not support reading logs",
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const wrapper = await mountExpandedListCard({ enableLogs: true });

      expect(wrapper.text()).toContain('logging driver may not support reading logs');
      expect(wrapper.text()).not.toContain('No logs available.');
    });

    it('still shows the empty state when the container is simply quiet', async () => {
      fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('action=logs')) {
          return new Response(JSON.stringify({ logs: '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const wrapper = await mountExpandedListCard({ enableLogs: true });

      expect(wrapper.text()).toContain('No logs available.');
    });

    it('shows a "Logs" header label in the panel', async () => {
      const wrapper = await mountExpandedListCard({ enableLogs: true });

      const logsHeaders = wrapper.findAll('p').filter((p) => p.text() === 'Logs');
      expect(logsHeaders.length).toBe(1);
    });

    it('shows a refresh button that re-fetches logs', async () => {
      const wrapper = await mountExpandedListCard({ enableLogs: true });

      const refreshBtn = wrapper.findAll('button').find((b) => b.attributes('title') === 'Refresh logs');
      expect(refreshBtn).toBeTruthy();

      // Count fetch calls before clicking refresh
      const callsBefore = logsCallCount();

      await refreshBtn!.trigger('click');
      await flushPromises();

      expect(logsCallCount()).toBe(callsBefore + 1);
    });

    it('renders the same expanded detail layout in grid view as in list view', async () => {
      const findInfoRow = (w: ReturnType<typeof mount>) =>
        w.findAll('div').find((d) => d.classes().includes('md:grid-cols-2'));

      const listRow = findInfoRow(await mountExpandedListCard({ enableLogs: true }));

      const gridCard = mountCardWithSharedPinia(
        { state: 'running' },
        { view: 'grid' },
        { enableLogs: true, seedStatsId: 'abc123' },
      );
      await gridCard.find('.cursor-pointer').trigger('click');
      await flushPromises();
      const gridRow = findInfoRow(gridCard);

      expect(listRow).toBeTruthy();
      expect(gridRow).toBeTruthy();
      // Same info-row grid definition, and the same sections underneath.
      expect(gridRow!.classes()).toEqual(listRow!.classes());
      for (const section of ['Resource Usage', 'Block I/O', 'Net I/O', 'Uptime']) {
        expect(gridCard.text()).toContain(section);
      }
    });

    it('renders the logs panel as a full-width row, not a column beside the stats', async () => {
      const wrapper = await mountExpandedListCard({ enableLogs: true });

      // The log pane must not sit inside a multi-column grid — it owns its own row.
      const logPane = wrapper.findAll('div').find((d) => d.text().includes('server started') && d.classes().includes('font-mono'));
      expect(logPane).toBeTruthy();

      const splitGrid = wrapper.findAll('div').find((d) =>
        d.classes().includes('lg:grid-cols-2') && d.text().includes('server started'),
      );
      expect(splitGrid).toBeUndefined();
    });

    it('keeps the full-width stats row and two-column info row regardless of the inline logs setting', async () => {
      for (const enableLogs of [true, false]) {
        const wrapper = await mountExpandedListCard({ enableLogs });

        // Resource usage owns its own row — not a cell in a multi-column grid.
        const statsRow = wrapper.findAll('div').find((d) => d.text().startsWith('Resource Usage'));
        expect(statsRow).toBeTruthy();
        expect(statsRow!.classes().some((c) => c.startsWith('md:grid-cols'))).toBe(false);

        // Metadata sits to the left of the I/O counters in the info row below.
        const infoRow = wrapper.findAll('div').find((d) => d.classes().includes('md:grid-cols-2'));
        expect(infoRow).toBeTruthy();
        expect(infoRow!.text()).toContain('Block I/O');
        expect(infoRow!.text()).toContain('Image');
        expect(infoRow!.text()).toContain('Ports');
      }
    });

    it('does not show log panel for exited containers', async () => {
      const wrapper = mountCardWithSharedPinia(
        { state: 'exited' },
        { view: 'list' },
        { enableLogs: true },
      );

      // Expand
      const row = wrapper.find('.container-row > div');
      await row.trigger('click');
      await flushPromises();

      const refreshBtn = wrapper.findAll('button').find((b) => b.attributes('title') === 'Refresh logs');
      expect(refreshBtn).toBeUndefined();
    });

    it('passes container name in the logs fetch URL', async () => {
      await mountExpandedListCard({
        enableLogs: true,
        containerOverrides: { name: 'my-app' },
      });

      const logsCall = findLogsCall();
      expect(logsCall).toBeTruthy();
      const url = typeof logsCall![0] === 'string' ? logsCall![0] : (logsCall![0] as Request).url;
      expect(url).toContain('id=my-app');
      expect(url).toContain('tail=50');
    });

    it('shows "No logs available." when API returns empty logs', async () => {
      fetchSpy.mockRestore();
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('action=logs')) {
          return new Response(JSON.stringify({ logs: '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const wrapper = await mountExpandedListCard({ enableLogs: true });

      expect(wrapper.text()).toContain('No logs available.');
    });

    it('shows "Failed to load logs." when fetch throws', async () => {
      fetchSpy.mockRestore();
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('action=logs')) {
          throw new Error('network failure');
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const wrapper = await mountExpandedListCard({ enableLogs: true });

      expect(wrapper.text()).toContain('Failed to load logs.');
    });

    describe('auto-refresh polling', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('auto-refreshes logs on interval when panel is open', async () => {
        const pinia = createPinia();
        setActivePinia(pinia);

        const settingsStore = useSettingsStore();
        settingsStore.showInlineLogs = true;
        settingsStore.logRefreshInterval = 10;

        const statsStore = useStatsStore();
        statsStore.stats['abc123'] = { ...FAKE_STATS };

        const wrapper = mount(ContainerCard, {
          props: {
            container: makeContainer({ state: 'running' }),
            view: 'list' as const,
          },
          global: {
            plugins: [pinia],
            stubs: { Teleport: true },
          },
        });

        // Expand
        const row = wrapper.find('.container-row > div');
        await row.trigger('click');
        await flushPromises();

        const callsAfterOpen = logsCallCount();
        expect(callsAfterOpen).toBeGreaterThanOrEqual(1);

        // Advance timer by 10 seconds
        vi.advanceTimersByTime(10000);
        await flushPromises();

        expect(logsCallCount()).toBeGreaterThan(callsAfterOpen);

        wrapper.unmount();
      });

      it('stops polling when panel is collapsed', async () => {
        const pinia = createPinia();
        setActivePinia(pinia);

        const settingsStore = useSettingsStore();
        settingsStore.showInlineLogs = true;
        settingsStore.logRefreshInterval = 5;

        const statsStore = useStatsStore();
        statsStore.stats['abc123'] = { ...FAKE_STATS };

        const wrapper = mount(ContainerCard, {
          props: {
            container: makeContainer({ state: 'running' }),
            view: 'list' as const,
          },
          global: {
            plugins: [pinia],
            stubs: { Teleport: true },
          },
        });

        // Expand
        const row = wrapper.find('.container-row > div');
        await row.trigger('click');
        await flushPromises();

        // Collapse
        await row.trigger('click');
        await flushPromises();

        const callsAfterCollapse = logsCallCount();

        // Advance timer — should NOT trigger more fetches
        vi.advanceTimersByTime(15000);
        await flushPromises();

        expect(logsCallCount()).toBe(callsAfterCollapse);

        wrapper.unmount();
      });

      it('does not poll when interval is 0 (disabled)', async () => {
        const pinia = createPinia();
        setActivePinia(pinia);

        const settingsStore = useSettingsStore();
        settingsStore.showInlineLogs = true;
        settingsStore.logRefreshInterval = 0;

        const statsStore = useStatsStore();
        statsStore.stats['abc123'] = { ...FAKE_STATS };

        const wrapper = mount(ContainerCard, {
          props: {
            container: makeContainer({ state: 'running' }),
            view: 'list' as const,
          },
          global: {
            plugins: [pinia],
            stubs: { Teleport: true },
          },
        });

        // Expand
        const row = wrapper.find('.container-row > div');
        await row.trigger('click');
        await flushPromises();

        // Initial fetch happens
        const callsAfterOpen = logsCallCount();
        expect(callsAfterOpen).toBeGreaterThanOrEqual(1);

        // Advance timer — no additional fetches
        vi.advanceTimersByTime(30000);
        await flushPromises();

        expect(logsCallCount()).toBe(callsAfterOpen);

        wrapper.unmount();
      });
    });

    describe('port conflicts in expanded details', () => {
      /** Seed the docker store with a running holder + the card's stopped container. */
      function mountConflictCard(view: 'grid' | 'list', cardConflicts = true) {
        const pinia = createPinia();
        setActivePinia(pinia);

        const docker = useDockerStore();
        docker.containers = [
          makeContainer({
            id: 'run-grafana', name: 'grafana', state: 'running',
            ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }],
            hostPorts: [{ hostIp: '0.0.0.0', hostPort: 3000, containerPort: 3000, type: 'tcp' }],
          }),
          makeContainer({
            id: 'stop-grafana', name: 'grafana-canary', state: 'exited',
            ports: [{ IP: '', PrivatePort: 3000, Type: 'tcp' }],
            // When cardConflicts is false, bind a free host port instead.
            hostPorts: [{ hostIp: '0.0.0.0', hostPort: cardConflicts ? 3000 : 3001, containerPort: 3000, type: 'tcp' }],
          }),
        ];

        return mount(ContainerCard, {
          props: { container: docker.containers[1], view },
          global: { plugins: [pinia], stubs: { Teleport: true } },
        });
      }

      it('shows the conflicting port in red with holder names (grid view)', async () => {
        const wrapper = mountConflictCard('grid');
        // Expand via the summary row.
        await wrapper.find('.cursor-pointer').trigger('click');
        await flushPromises();

        const portLine = wrapper.findAll('p').find((p) => p.text().includes('3000/tcp'));
        expect(portLine).toBeTruthy();
        expect(portLine!.text()).toContain('conflicts with grafana');
        expect(portLine!.classes()).toContain('text-error');
      });

      it('shows the conflicting port in red with holder names (list view)', async () => {
        const wrapper = mountConflictCard('list');
        await wrapper.find('.container-row > div').trigger('click');
        await flushPromises();

        const portLine = wrapper.findAll('p').find((p) => p.text().includes('3000/tcp'));
        expect(portLine).toBeTruthy();
        expect(portLine!.text()).toContain('conflicts with grafana');
        expect(portLine!.classes()).toContain('text-error');
      });

      it('does not flag the port when there is no conflict', async () => {
        const wrapper = mountConflictCard('grid', false);
        await wrapper.find('.cursor-pointer').trigger('click');
        await flushPromises();

        const portLine = wrapper.findAll('p').find((p) => p.text().includes('3000/tcp'));
        expect(portLine).toBeTruthy();
        expect(portLine!.text()).not.toContain('conflicts with');
        expect(portLine!.classes()).not.toContain('text-error');
      });
    });
  });
});
