import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useComposeStore } from '../compose';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);
const reply = (ok: boolean, body: Record<string, unknown>) => ({ ok, json: async () => body }) as Response;

describe('compose store – installBinary', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  it('keeps the warning when the install worked but the flash copy did not', async () => {
    mockApiFetch.mockResolvedValue(reply(true, { success: true, status: {}, warning: 'copy failed' }));
    const store = useComposeStore();
    await expect(store.installBinary()).resolves.toBe(true);
    expect(store.installWarning).toBe('copy failed');
  });

  it('has no warning after a clean install', async () => {
    mockApiFetch.mockResolvedValue(reply(true, { success: true, status: {} }));
    const store = useComposeStore();
    store.installWarning = 'old';
    await store.installBinary();
    expect(store.installWarning).toBeNull();
  });

  it.each([[true], [false]])('keeps auto_install=%s from the reply', async (value) => {
    mockApiFetch.mockResolvedValue(reply(true, { success: true, status: {}, auto_install: value }));
    const store = useComposeStore();
    await store.installBinary();
    expect(store.installAutoInstall).toBe(value);
  });

  it('has no warning after a failed install', async () => {
    mockApiFetch.mockResolvedValue(reply(false, { message: 'Download failed' }));
    const store = useComposeStore();
    await expect(store.installBinary()).resolves.toBe(false);
    expect(store.installWarning).toBeNull();
  });
});
