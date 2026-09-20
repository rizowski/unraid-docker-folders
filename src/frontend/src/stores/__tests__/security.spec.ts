import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

import { apiFetch } from '@/utils/csrf';
import { useSecurityStore } from '@/stores/security';
import { useDockerStore } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { makeContainer } from '@/test/fixtures';

const mockApiFetch = vi.mocked(apiFetch);

const ok = () => ({ ok: true, json: async () => ({ success: true }) }) as Response;

describe('security store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(ok());
  });

  it('flags a running container and counts its findings', () => {
    const docker = useDockerStore();
    docker.containers = [makeContainer({ name: 'plex', privileged: true })];

    const security = useSecurityStore();
    expect(security.findingCount).toBe(1);
    expect(security.hasCritical).toBe(true);
    expect(security.flagged.map((f) => f.container.name)).toEqual(['plex']);
  });

  it('leaves stopped containers out', () => {
    const docker = useDockerStore();
    docker.containers = [makeContainer({ name: 'plex', state: 'exited', privileged: true })];

    const security = useSecurityStore();
    expect(security.findingCount).toBe(0);
    expect(security.flagged).toEqual([]);
  });

  it('reports nothing when the setting is off', () => {
    const docker = useDockerStore();
    docker.containers = [makeContainer({ privileged: true })];
    useSettingsStore().enableSecurityAdvisor = false;

    const security = useSecurityStore();
    expect(security.findingCount).toBe(0);
  });

  it('hides a dismissed finding and keeps the others', () => {
    const docker = useDockerStore();
    docker.containers = [makeContainer({ name: 'plex', privileged: true, capAdd: ['NET_ADMIN'] })];
    docker.securityDismissals = [{ container_name: 'plex', finding_type: 'privileged' }];

    const security = useSecurityStore();
    expect(security.findings(docker.containers[0]).map((f) => f.type)).toEqual(['added-capabilities']);
    expect(security.dismissedFindings(docker.containers[0]).map((f) => f.type)).toEqual(['privileged']);
    expect(security.findingCount).toBe(1);
  });

  it('keys dismissals per container, not globally', () => {
    const docker = useDockerStore();
    docker.containers = [
      makeContainer({ id: 'a', name: 'plex', privileged: true }),
      makeContainer({ id: 'b', name: 'sonarr', privileged: true }),
    ];
    docker.securityDismissals = [{ container_name: 'plex', finding_type: 'privileged' }];

    const security = useSecurityStore();
    expect(security.flagged.map((f) => f.container.name)).toEqual(['sonarr']);
  });

  it('posts a dismissal and hides the finding straight away', async () => {
    const docker = useDockerStore();
    docker.containers = [makeContainer({ name: 'plex', privileged: true })];

    const security = useSecurityStore();
    await security.dismiss('plex', 'privileged');

    expect(security.findingCount).toBe(0);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockApiFetch.mock.calls[0];
    expect(url).toContain('action=dismiss-finding');
    expect(JSON.parse((options as RequestInit).body as string)).toEqual({
      container_name: 'plex',
      finding_type: 'privileged',
    });
  });

  it('posts a restore and shows the finding again', async () => {
    const docker = useDockerStore();
    docker.containers = [makeContainer({ name: 'plex', privileged: true })];
    docker.securityDismissals = [{ container_name: 'plex', finding_type: 'privileged' }];

    const security = useSecurityStore();
    await security.restore('plex', 'privileged');

    expect(security.findingCount).toBe(1);
    expect(mockApiFetch.mock.calls[0][0]).toContain('action=restore-finding');
  });

  it('refetches when the server rejects a dismissal', async () => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 400 } as Response);
    // The recovery refetch, which the store makes to undo its optimistic change.
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ containers: [], dismissals: [] }),
    } as Response);

    const docker = useDockerStore();
    docker.containers = [makeContainer({ name: 'plex', privileged: true })];

    const security = useSecurityStore();
    expect(await security.dismiss('plex', 'privileged')).toBe(false);
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('counts a host-network container as holding its exposed ports', () => {
    const docker = useDockerStore();
    docker.containers = [
      makeContainer({ id: 'a', name: 'homeassistant', networkMode: 'host', exposedPorts: ['8123/tcp'] }),
      makeContainer({ id: 'b', name: 'other', networkMode: 'host', exposedPorts: ['8123/tcp'] }),
    ];

    const security = useSecurityStore();
    // 'other' sees 8123 held by homeassistant and must move up.
    const finding = security.findings(docker.containers[1])[0];
    expect(finding.detail).toEqual([
      { remove: 'Network Type: host', add: 'Network Type: bridge' },
      { add: '8124:8123', note: 'homeassistant is using 8123, so this moves up to 8124.' },
    ]);
  });
});
