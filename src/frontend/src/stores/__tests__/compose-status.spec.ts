import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useComposeStore } from '../compose';

// Mock apiFetch so no real HTTP requests are made
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';

const mockApiFetch = vi.mocked(apiFetch);

function statusResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({
      compose_available: true,
      compose_version: '2.29.0',
      compose_plugin_installed: false,
      management_enabled: true,
      compose_plugin_data_exists: false,
      ...overrides,
    }),
  } as Response;
}

describe('compose store – action availability', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
  });

  /**
   * Compose buttons render unconditionally and disable themselves. Before the
   * status check resolves we do not yet know whether the actions work, so they
   * must start disabled rather than briefly clickable.
   */
  it('disables actions before the status check resolves', () => {
    const store = useComposeStore();
    expect(store.statusChecked).toBe(false);
    expect(store.composeActionsDisabled).toBe(true);
    expect(store.composeDisabledReason).toBe('Checking Docker Compose availability...');
  });

  it('enables actions once compose is confirmed available', async () => {
    mockApiFetch.mockResolvedValueOnce(statusResponse());

    const store = useComposeStore();
    await store.fetchStatus();

    expect(store.composeActionsDisabled).toBe(false);
    expect(store.composeDisabledReason).toBeNull();
  });

  it('keeps actions disabled when compose is not installed', async () => {
    mockApiFetch.mockResolvedValueOnce(
      statusResponse({ compose_available: false, management_enabled: false })
    );

    const store = useComposeStore();
    await store.fetchStatus();

    expect(store.composeActionsDisabled).toBe(true);
    expect(store.composeDisabledReason).toBe('Docker Compose is not installed');
  });

  it('explains that the compose.manager plugin is what disabled management', async () => {
    mockApiFetch.mockResolvedValueOnce(
      statusResponse({ compose_plugin_installed: true, management_enabled: false })
    );

    const store = useComposeStore();
    await store.fetchStatus();

    expect(store.composeActionsDisabled).toBe(true);
    expect(store.composeDisabledReason).toBe(
      'Disabled: the Compose Manager plugin is installed'
    );
  });

  /**
   * A failed status request must not silently flip actions to enabled.
   */
  it('leaves actions disabled when the status request fails', async () => {
    mockApiFetch.mockRejectedValueOnce(new Error('network failure'));

    const store = useComposeStore();
    await store.fetchStatus();

    expect(store.statusChecked).toBe(false);
    expect(store.composeActionsDisabled).toBe(true);
  });
});
