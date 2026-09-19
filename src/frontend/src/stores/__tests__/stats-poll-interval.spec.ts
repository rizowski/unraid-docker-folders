import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useStatsStore } from '../stats';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ stats: {} }) })),
}));

import { apiFetch } from '@/utils/csrf';

describe('stats store poll interval', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.mocked(apiFetch).mockClear();
  });
  afterEach(() => {
    useStatsStore().cleanup();
    vi.useRealTimers();
  });

  it('polls every 5 seconds by default', async () => {
    const store = useStatsStore();
    store.registerVisible('c1');
    await vi.advanceTimersByTimeAsync(50);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('restarts a running timer at the new rate', async () => {
    const store = useStatsStore();
    store.registerVisible('c1');
    await vi.advanceTimersByTimeAsync(50);
    store.setPollInterval(15000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('uses the new rate for a timer that starts later', async () => {
    const store = useStatsStore();
    store.setPollInterval(15000);
    store.registerVisible('c1');
    await vi.advanceTimersByTimeAsync(50 + 14000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
