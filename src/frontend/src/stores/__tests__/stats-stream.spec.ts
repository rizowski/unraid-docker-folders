import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setActiveBackend } from '@/backends';
import { phpBackend } from '@/backends/php';
import type { Backend, LiveHandlers } from '@/backends/types';
import { useStatsStore, type ContainerStats } from '../stats';

type StatsHandlers = LiveHandlers<Record<string, ContainerStats | null>>;

interface OpenStream {
  ids: string[];
  intervalMs: number;
  handlers: StatsHandlers;
  close: ReturnType<typeof vi.fn>;
}

function reading(cpuPercent: number): ContainerStats {
  return {
    cpuPercent,
    memoryUsage: 0,
    memoryLimit: 0,
    memoryPercent: 0,
    blockRead: 0,
    blockWrite: 0,
    netRx: 0,
    netTx: 0,
    pids: 0,
    restartCount: 0,
    startedAt: '',
    imageSize: 0,
    logSize: 0,
  };
}

describe('stats store with a live backend', () => {
  let opened: OpenStream[];
  let get: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    opened = [];
    get = vi.fn(async () => ({ ok: true, status: 200, data: { stats: {} } }));

    const live: NonNullable<Backend['live']> = {
      stats: (ids, intervalMs, handlers) => {
        const close = vi.fn();
        opened.push({ ids, intervalMs, handlers, close });
        return close;
      },
      logs: () => () => undefined,
      composeLogs: () => () => undefined,
    };
    setActiveBackend({ ...phpBackend, stats: { get }, live } as Backend);
  });

  afterEach(() => {
    useStatsStore().cleanup();
    setActiveBackend(phpBackend);
    vi.useRealTimers();
  });

  it('opens one stream for a batch of registrations and does not poll', async () => {
    const store = useStatsStore();
    store.registerVisible('a');
    store.registerVisible('b');
    await vi.advanceTimersByTimeAsync(50);

    expect(opened).toHaveLength(1);
    expect(opened[0].ids.sort()).toEqual(['a', 'b']);
    expect(opened[0].intervalMs).toBe(2000);

    await vi.advanceTimersByTimeAsync(20000);
    expect(get).not.toHaveBeenCalled();
  });

  it('stores what the stream sends', async () => {
    const store = useStatsStore();
    store.registerVisible('a');
    await vi.advanceTimersByTimeAsync(50);

    opened[0].handlers.onData({ a: reading(12) });

    expect(store.getStats('a')?.cpuPercent).toBe(12);
  });

  it('reopens the stream when the set changes, and not when it does not', async () => {
    const store = useStatsStore();
    store.registerVisible('a');
    await vi.advanceTimersByTimeAsync(50);

    store.registerExpanded('a');
    await vi.advanceTimersByTimeAsync(50);
    expect(opened).toHaveLength(1);

    store.registerVisible('b');
    await vi.advanceTimersByTimeAsync(50);
    expect(opened).toHaveLength(2);
    expect(opened[0].close).toHaveBeenCalled();
  });

  it('keeps streaming at 2 seconds when a caller sets a slower poll', async () => {
    const store = useStatsStore();
    store.setPollInterval(15000);
    store.registerVisible('a');
    await vi.advanceTimersByTimeAsync(50);

    store.setPollInterval(30000);

    expect(opened).toHaveLength(1);
    expect(opened[0].intervalMs).toBe(2000);
  });

  it('polls after the stream drops, then opens it again', async () => {
    const store = useStatsStore();
    store.registerVisible('a');
    await vi.advanceTimersByTimeAsync(50);

    opened[0].handlers.onEnd('Live update connection closed: code 1006');
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10000);
    expect(opened).toHaveLength(2);

    const polls = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(polls);
  });

  it('closes the stream when nothing is tracked', async () => {
    const store = useStatsStore();
    store.registerVisible('a');
    await vi.advanceTimersByTimeAsync(50);

    store.unregisterVisible('a');

    expect(opened[0].close).toHaveBeenCalled();
  });
});
