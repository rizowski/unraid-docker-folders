import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSettingsStore } from '../settings';

// Mock apiFetch so no real HTTP requests are made
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

describe('settings store – showInlineLogs', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('defaults showInlineLogs to false', () => {
    const store = useSettingsStore();
    expect(store.showInlineLogs).toBe(false);
  });

  it('fetchSettings reads show_inline_logs="1" as true', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { show_inline_logs: '1' } }),
    } as Response);

    const store = useSettingsStore();
    await store.fetchSettings();

    expect(store.showInlineLogs).toBe(true);
  });

  it('fetchSettings reads show_inline_logs="0" as false', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { show_inline_logs: '0' } }),
    } as Response);

    const store = useSettingsStore();
    await store.fetchSettings();

    expect(store.showInlineLogs).toBe(false);
  });

  it('fetchSettings leaves showInlineLogs as default when key is absent', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: {} }),
    } as Response);

    const store = useSettingsStore();
    await store.fetchSettings();

    expect(store.showInlineLogs).toBe(false);
  });

  it('setShowInlineLogs(true) updates the ref and POSTs to the API', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true } as Response);

    const store = useSettingsStore();
    await store.setShowInlineLogs(true);

    expect(store.showInlineLogs).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockApiFetch.mock.calls[0];
    expect(url).toContain('settings.php');
    expect(opts?.method).toBe('POST');
    expect(opts?.body).toContain('show_inline_logs');
    expect(opts?.body).toContain('"1"');
  });

  it('setShowInlineLogs(false) updates the ref and POSTs "0"', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true } as Response);

    const store = useSettingsStore();
    store.showInlineLogs = true; // pre-set
    await store.setShowInlineLogs(false);

    expect(store.showInlineLogs).toBe(false);

    const [, opts] = mockApiFetch.mock.calls[0];
    expect(opts?.body).toContain('"0"');
  });

  it('setShowInlineLogs still updates the ref when the API call fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('network failure'));

    const store = useSettingsStore();
    await store.setShowInlineLogs(true);

    // Ref is set optimistically before await
    expect(store.showInlineLogs).toBe(true);
  });
});

describe('settings store – logRefreshInterval', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('defaults logRefreshInterval to 10', () => {
    const store = useSettingsStore();
    expect(store.logRefreshInterval).toBe(10);
  });

  it('fetchSettings reads log_refresh_interval string as number', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { log_refresh_interval: '30' } }),
    } as Response);

    const store = useSettingsStore();
    await store.fetchSettings();

    expect(store.logRefreshInterval).toBe(30);
  });

  it('fetchSettings defaults to 10 for non-numeric value', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { log_refresh_interval: 'abc' } }),
    } as Response);

    const store = useSettingsStore();
    await store.fetchSettings();

    expect(store.logRefreshInterval).toBe(10);
  });

  it('fetchSettings reads "0" as 0 (disabled)', async () => {
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ settings: { log_refresh_interval: '0' } }),
    } as Response);

    const store = useSettingsStore();
    await store.fetchSettings();

    expect(store.logRefreshInterval).toBe(0);
  });

  it('setLogRefreshInterval updates ref and POSTs string value', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: true } as Response);

    const store = useSettingsStore();
    await store.setLogRefreshInterval(30);

    expect(store.logRefreshInterval).toBe(30);
    expect(mockApiFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockApiFetch.mock.calls[0];
    expect(url).toContain('settings.php');
    expect(opts?.method).toBe('POST');
    expect(opts?.body).toContain('log_refresh_interval');
    expect(opts?.body).toContain('"30"');
  });
});
