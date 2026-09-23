import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import ContainerCard from '../ContainerCard.vue';
import { useSettingsStore } from '@/stores/settings';
import { setActiveBackend } from '@/backends';
import { phpBackend } from '@/backends/php';
import type { Backend, ErrorBody, LiveHandlers } from '@/backends/types';
import { makeContainer } from '@/test/fixtures';

type LogHandlers = LiveHandlers<ErrorBody & { logs?: string }>;

describe('ContainerCard inline logs with a live backend', () => {
  let pinia: Pinia;
  let streams: { name: string; handlers: LogHandlers; close: ReturnType<typeof vi.fn> }[];
  let logs: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    pinia = createPinia();
    setActivePinia(pinia);
    streams = [];
    logs = vi.fn(async () => ({ ok: true, status: 200, data: { logs: 'polled' } }));

    const live: NonNullable<Backend['live']> = {
      stats: () => () => undefined,
      logs: (name, _tail, handlers) => {
        const close = vi.fn();
        streams.push({ name, handlers, close });
        return close;
      },
      composeLogs: () => () => undefined,
    };
    setActiveBackend({
      ...phpBackend,
      containers: { ...phpBackend.containers, logs },
      stats: { get: async () => ({ ok: true, status: 200, data: { stats: {} } }) },
      live,
    } as Backend);
  });

  afterEach(() => {
    setActiveBackend(phpBackend);
    vi.useRealTimers();
  });

  async function mountExpanded() {
    const settings = useSettingsStore();
    settings.showInlineLogs = true;
    settings.logRefreshInterval = 10;
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer({ state: 'running' }), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    await wrapper.find('h3').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('streams instead of polling, and puts new lines on top', async () => {
    const wrapper = await mountExpanded();

    expect(streams).toHaveLength(1);
    streams[0].handlers.onData({ logs: 'two\none', error: false });
    await flushPromises();
    streams[0].handlers.onData({ logs: 'four\nthree', error: false });
    await flushPromises();

    const text = wrapper.find('.log-pane').text();
    expect(text.indexOf('four')).toBeLessThan(text.indexOf('two'));
    await vi.advanceTimersByTimeAsync(30000);
    expect(logs).not.toHaveBeenCalled();
  });

  it('polls after the stream drops, then streams again', async () => {
    await mountExpanded();

    streams[0].handlers.onEnd('Live update connection closed: code 1006');
    await flushPromises();
    expect(logs).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10000);
    expect(logs).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(streams).toHaveLength(2);
  });

  it('fetches once and does not stream when the refresh interval is 0', async () => {
    const settings = useSettingsStore();
    settings.logRefreshInterval = 0;
    const wrapper = mount(ContainerCard, {
      props: { container: makeContainer({ state: 'running' }), view: 'grid' as const },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    settings.showInlineLogs = true;
    await wrapper.find('h3').trigger('click');
    await flushPromises();

    expect(streams).toHaveLength(0);
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('closes the stream when the card collapses', async () => {
    const wrapper = await mountExpanded();

    await wrapper.find('h3').trigger('click');
    await flushPromises();

    expect(streams[0].close).toHaveBeenCalled();
  });
});
