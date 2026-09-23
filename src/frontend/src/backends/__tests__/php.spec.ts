import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => 'test-token'),
}));

import { apiFetch } from '@/utils/csrf';
import { phpBackend } from '../php';

/** One `api/*.php` reply. */
function phpResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('php backend error normalization', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('leaves error unset on success', async () => {
    vi.mocked(apiFetch).mockResolvedValue(phpResponse({ folders: [] }));

    const { ok, error } = await phpBackend.folders.list();

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
  });

  it('prefers the message field the endpoints usually send', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      phpResponse({ error: true, message: 'Folder not found' }, 404),
    );

    const { error } = await phpBackend.folders.remove(7);

    expect(error).toBe('Folder not found');
  });

  it('reads the error field when the endpoint put the text there instead', async () => {
    vi.mocked(apiFetch).mockResolvedValue(phpResponse({ error: 'compose is not installed' }, 500));

    const { error } = await phpBackend.compose.logs('media', 100);

    expect(error).toBe('compose is not installed');
  });

  it('falls back to the status line when the body said nothing', async () => {
    vi.mocked(apiFetch).mockResolvedValue(phpResponse({}, 503));

    const { error } = await phpBackend.settings.getAll();

    expect(error).toBe('HTTP 503');
  });

  it('reports a transport failure in words rather than as HTTP 0', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network down'));

    const { ok, status, error } = await phpBackend.containers.list();

    expect(ok).toBe(false);
    expect(status).toBe(0);
    expect(error).toBe('The server did not respond.');
  });
});
