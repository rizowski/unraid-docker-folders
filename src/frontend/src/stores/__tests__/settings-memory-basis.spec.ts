import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSettingsStore } from '../settings';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

function answer(settings: Record<string, string>) {
  mockApiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ settings }) } as Response);
}

describe('settings store – memoryPercentBasis', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('defaults to limit', () => {
    expect(useSettingsStore().memoryPercentBasis).toBe('limit');
  });

  it('fetchSettings reads host, and treats an unknown value as limit', async () => {
    const store = useSettingsStore();
    answer({ memory_percent_basis: 'host' });
    await store.fetchSettings();
    expect(store.memoryPercentBasis).toBe('host');

    answer({ memory_percent_basis: 'bogus' });
    await store.fetchSettings();
    expect(store.memoryPercentBasis).toBe('limit');
  });

  it('keeps limit when the backend does not send the key', async () => {
    const store = useSettingsStore();
    answer({});
    await store.fetchSettings();
    expect(store.memoryPercentBasis).toBe('limit');
  });
});
