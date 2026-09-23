import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => 'test-token'),
}));

import { apiFetch } from '@/utils/csrf';
import { graphqlBackend, probeGraphqlBackend } from '../graphql';
import { phpBackend } from '../php';
import { initBackend, useBackend, requestedMode, fallbackReason } from '../index';

const originalFetch = globalThis.fetch;

/** One GraphQL reply. `errors` alone is how the API reports a failed field. */
function gqlResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** One folder as the plugin's schema answers it. */
function gqlFolder(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    name: 'Media',
    icon: null,
    color: null,
    position: 0,
    collapsed: false,
    composeProject: null,
    sortMode: 'manual',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    containers: [{ id: 1, containerId: 'abc', containerName: 'plex', position: 0 }],
    ...overrides,
  };
}

function setBackendParam(value: string | null) {
  const search = value === null ? '' : `?backend=${value}`;
  Object.defineProperty(window, 'location', {
    value: { search },
    writable: true,
  });
}

describe('graphql backend', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    delete window.dockerFoldersBackendMode;
    setBackendParam(null);
    fallbackReason.value = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends the CSRF token as a header, not a body field', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { dockerFoldersInfo: { version: '0.0.1', databaseReadable: true } } }),
    );

    await probeGraphqlBackend();

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('/graphql');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('test-token');
    expect(init?.credentials).toBe('include');
    expect(init?.body as string).not.toContain('csrf_token=');
  });

  it('maps the plugin folder shape onto the app folder shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          dockerFolderLayout: {
            unfolderedOrder: ['plex', 'sonarr'],
            folders: [
              {
                id: 3,
                name: 'Media',
                icon: 'folder',
                color: '#b7f019',
                position: 0,
                collapsed: true,
                composeProject: null,
                sortMode: 'name-asc',
                createdAt: 1700000000,
                updatedAt: 1700000001,
                containers: [
                  { id: 11, containerId: 'abc123', containerName: 'radarr', position: 0 },
                ],
              },
            ],
          },
        },
      }),
    );

    const { ok, data } = await graphqlBackend.folders.list();

    expect(ok).toBe(true);
    expect(data.unfoldered_order).toEqual(['plex', 'sonarr']);
    expect(data.folders?.[0]).toEqual({
      id: 3,
      name: 'Media',
      icon: 'folder',
      color: '#b7f019',
      position: 0,
      collapsed: true,
      compose_project: null,
      sort_mode: 'name-asc',
      created_at: 1700000000,
      updated_at: 1700000001,
      containers: [
        {
          id: 11,
          container_id: 'abc123',
          container_name: 'radarr',
          // The member rows carry no folder_id, so it comes from the parent.
          folder_id: 3,
          position: 0,
        },
      ],
    });
  });

  it('treats a GraphQL error as a failure even though the transport returned 200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Invalid CSRF token' }], data: null }),
    );

    const { ok, error, status, data } = await graphqlBackend.folders.list();

    expect(ok).toBe(false);
    expect(data.folders).toBeUndefined();
    // The status line says 200, so a store that built its message out of it
    // would tell the user the call succeeded.
    expect(status).toBe(200);
    expect(error).toBe('Invalid CSRF token');
  });

  it('implements every domain itself rather than falling back to PHP', () => {
    // Same function identity as the PHP backend's would fail these — every
    // domain below is now the plugin's own implementation.
    expect(graphqlBackend.containers.list).not.toBe(phpBackend.containers.list);
    expect(graphqlBackend.containers.logs).not.toBe(phpBackend.containers.logs);
    expect(graphqlBackend.containers.setAutostart).not.toBe(phpBackend.containers.setAutostart);
    expect(graphqlBackend.containers.adoptFields).not.toBe(phpBackend.containers.adoptFields);
    expect(graphqlBackend.settings.getAll).not.toBe(phpBackend.settings.getAll);
    expect(graphqlBackend.folders.exportConfig).not.toBe(phpBackend.folders.exportConfig);
    expect(graphqlBackend.folders.importConfig).not.toBe(phpBackend.folders.importConfig);
    expect(graphqlBackend.folders.list).not.toBe(phpBackend.folders.list);
    expect(graphqlBackend.folders.create).not.toBe(phpBackend.folders.create);
    // Compose and schedules are now the plugin's own implementation, not PHP.
    expect(graphqlBackend.compose.status).not.toBe(phpBackend.compose.status);
    expect(graphqlBackend.compose.stackAction).not.toBe(phpBackend.compose.stackAction);
    expect(graphqlBackend.schedules.list).not.toBe(phpBackend.schedules.list);
    expect(graphqlBackend.schedules.create).not.toBe(phpBackend.schedules.create);
    expect(graphqlBackend.updates.getCached).not.toBe(phpBackend.updates.getCached);
    expect(graphqlBackend.updates.check).not.toBe(phpBackend.updates.check);
    expect(graphqlBackend.stats.get).not.toBe(phpBackend.stats.get);
    expect(graphqlBackend.kind).toBe('graphql');
  });

  it('sends only the fields the caller named on an update', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { updateDockerFolder: gqlFolder() } }),
    );

    await graphqlBackend.folders.update(3, { collapsed: true });

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit)
      .body as string);
    expect(body.variables.id).toBe(3);
    expect(body.variables.input.collapsed).toBe(true);
    // Absent rather than null: the plugin leaves a column alone only when the
    // field is missing, which is what PHP's isset() checks do too.
    expect('name' in body.variables.input).toBe(false);
  });

  it('translates the store snake_case bodies into mutation arguments', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { reorderDockerFolderContainers: gqlFolder() } }),
    );

    await graphqlBackend.folders.reorderContainers(3, { container_ids: ['b', 'a'] });

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit)
      .body as string);
    expect(body.variables).toEqual({ folderId: 3, containerIds: ['b', 'a'] });
  });

  it('answers a write in the shape the folder store already reads', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { createDockerFolder: gqlFolder() } }),
    );

    const { ok, data } = await graphqlBackend.folders.create({ name: 'Media' });

    expect(ok).toBe(true);
    expect(data.folder?.sort_mode).toBe('manual');
    expect(data.folder?.compose_project).toBeNull();
    expect(data.folder?.containers[0].container_name).toBe('plex');
    expect(data.folder?.containers[0].folder_id).toBe(3);
  });

  it('gives the store a message when a write fails', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'No folder with id 9' }], data: null }),
    );

    const { ok, error } = await graphqlBackend.folders.remove(9);

    expect(ok).toBe(false);
    expect(error).toBe('No folder with id 9');
  });

  it('returns the order the plugin saved, not the order that was sent', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      // The plugin drops duplicates and empty names before it answers.
      gqlResponse({ data: { reorderUnfolderedDockerContainers: ['a', 'b'] } }),
    );

    const { data } = await graphqlBackend.folders.reorderUnfoldered({
      container_names: ['a', 'b', 'a'],
    });

    expect(data.unfoldered_order).toEqual(['a', 'b']);
  });
});

describe('graphql schedules', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rebuilds backup_config and the runner state in one request', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          dockerFoldersSchedules: [
            {
              id: 1,
              name: 'Nightly backup',
              targetType: 'container',
              targetId: 'plex',
              action: 'backup',
              cronExpression: '0 3 * * *',
              enabled: true,
              backupConfigJson: '{"paths":["/config"],"quiesce":"pause"}',
              lastRunAt: 1_700_000_000,
              lastRunStatus: 'success',
              lastRunMessage: 'ok',
              nextRunAt: 1_700_086_400,
              createdAt: 1_699_000_000,
              updatedAt: 1_699_000_000,
            },
          ],
          dockerFoldersScheduleRunner: { lastTick: 1_700_000_050, stale: false, staleAfter: 120, cronInstalled: true, repaired: false },
        },
      }),
    );

    const { ok, data } = await graphqlBackend.schedules.list();

    expect(ok).toBe(true);
    // One document, not two round trips.
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);
    expect(data.schedules?.[0].backup_config).toEqual({ paths: ['/config'], quiesce: 'pause' });
    expect(data.runner).toEqual({ last_tick: 1_700_000_050, stale: false, stale_after: 120, cron_installed: true, repaired: false });
  });

  it('stringifies backup_config into backupConfigJson and answers the new id', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { createDockerFoldersSchedule: 42 } }),
    );

    const { ok, data } = await graphqlBackend.schedules.create({
      name: 'Nightly backup',
      target_type: 'container',
      target_id: 'plex',
      action: 'backup',
      cron_expression: '0 3 * * *',
      enabled: true,
      backup_config: { paths: ['/config'] },
    });

    expect(ok).toBe(true);
    expect(data.id).toBe(42);
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.input.backupConfigJson).toBe(JSON.stringify({ paths: ['/config'] }));
    expect(body.variables.input.targetType).toBe('container');
  });

  it('gives the store a message when create fails validation', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Missing required field: name' }], data: null }),
    );

    const { ok, data } = await graphqlBackend.schedules.create({});

    expect(ok).toBe(false);
    expect(data.message).toBe('Missing required field: name');
  });
});

describe('graphql compose', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('gives the store the same result php.ts would for a missing compose file', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Compose file not found' }], data: null }),
    );

    const { ok, data } = await graphqlBackend.compose.getFile('media');

    expect(ok).toBe(false);
    // The store's getComposeFile() reads `data.message`, not the outer
    // `error`, on failure — see stores/compose.ts.
    expect(data.message).toBe('Compose file not found');
    expect(data.content).toBeUndefined();
  });

  it('maps force_recreate onto the forceRecreate argument for "up" only', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { bringUpDockerFoldersComposeStack: { success: true, output: 'done', error: null } } }),
    );

    await graphqlBackend.compose.stackAction('media', 'up', { force_recreate: true });

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ project: 'media', forceRecreate: true });
    expect(body.query).toContain('bringUpDockerFoldersComposeStack');
  });

  it('leaves forceRecreate out of the other stack actions', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { stopDockerFoldersComposeStack: { success: true, output: '', error: null } } }),
    );

    await graphqlBackend.compose.stackAction('media', 'stop', { force_recreate: true });

    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ project: 'media' });
  });

  it('gives the store a message when the management-disabled gate rejects a stack action', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        errors: [{ message: 'Compose management is disabled (compose_plugin may be installed)' }],
        data: null,
      }),
    );

    const { ok, data } = await graphqlBackend.compose.stackAction('media', 'up');

    expect(ok).toBe(false);
    // stackUp() in stores/compose.ts reads `data.message`, not the outer
    // `error`, to build the thrown Error.
    expect(data.message).toBe('Compose management is disabled (compose_plugin may be installed)');
  });

  it('converts a failed create into the shape the store expects', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          createDockerFoldersComposeStack: {
            success: false,
            error: "Stack 'media' already exists",
            projectName: null,
          },
        },
      }),
    );

    const { ok, data } = await graphqlBackend.compose.create({ project_name: 'media' });

    expect(ok).toBe(false);
    expect(data.message).toBe("Stack 'media' already exists");
  });
});

describe('backend selection', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    delete window.dockerFoldersBackendMode;
    setBackendParam(null);
    fallbackReason.value = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('defaults to PHP and never probes', async () => {
    const mode = await initBackend();

    expect(mode).toBe('php');
    expect(useBackend().kind).toBe('php');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reads the mode from the iframe query parameter', () => {
    setBackendParam('graphql');
    expect(requestedMode()).toBe('graphql');
  });

  it('prefers the global over the query parameter', () => {
    setBackendParam('graphql');
    window.dockerFoldersBackendMode = 'php';
    expect(requestedMode()).toBe('php');
  });

  it('selects GraphQL when the probe succeeds', async () => {
    setBackendParam('graphql');
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { dockerFoldersInfo: { version: '0.0.1', databaseReadable: true } } }),
    );

    const mode = await initBackend();

    expect(mode).toBe('graphql');
    expect(useBackend().kind).toBe('graphql');
    expect(fallbackReason.value).toBeNull();
  });

  it('falls back to PHP and records why when the plugin is not loaded', async () => {
    setBackendParam('graphql');
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Cannot query field "dockerFoldersInfo"' }], data: null }),
    );

    const mode = await initBackend();

    expect(mode).toBe('php');
    expect(useBackend().kind).toBe('php');
    expect(fallbackReason.value).toContain('dockerFoldersInfo');
  });

  it('falls back when the plugin loads but cannot read its database', async () => {
    setBackendParam('graphql');
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { dockerFoldersInfo: { version: '0.0.1', databaseReadable: false } } }),
    );

    const mode = await initBackend();

    expect(mode).toBe('php');
    expect(fallbackReason.value).toBe('The plugin cannot read its database.');
  });

  it('falls back when the probe hangs rather than leaving the app unmounted', async () => {
    setBackendParam('graphql');
    vi.useFakeTimers();
    // A socket that never answers, and never rejects on its own.
    vi.mocked(globalThis.fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );

    const pending = initBackend();
    await vi.advanceTimersByTimeAsync(5_000);
    const mode = await pending;
    vi.useRealTimers();

    expect(mode).toBe('php');
    expect(fallbackReason.value).toBe('The Unraid API did not respond.');
  });

  it('names one mutation per container button', async () => {
    const sent: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      sent.push(JSON.parse((init as RequestInit).body as string).query as string);
      return gqlResponse({ data: { ok: true } });
    });

    await graphqlBackend.containers.action('start', 'abc');
    await graphqlBackend.containers.action('resume', 'abc');
    await graphqlBackend.containers.action('stop', 'abc');
    await graphqlBackend.containers.action('restart', 'abc');

    expect(sent.map((query) => query.match(/mutation (\w+)/)?.[1])).toEqual([
      'StartDockerContainer',
      'ResumeDockerContainer',
      'StopDockerContainer',
      'RestartDockerContainer',
    ]);
  });

  it('turns the remove body into a named argument', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { removeDockerContainer: true } }),
    );

    await graphqlBackend.containers.action('remove', 'abc', { remove_image: true });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.variables).toEqual({ id: 'abc', removeImage: true });
  });

  it('asks to keep the image when the caller said nothing', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { removeDockerContainer: true } }),
    );

    await graphqlBackend.containers.action('remove', 'abc');

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).variables.removeImage).toBe(false);
  });

  it('reports why a container action failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Could not stop container: container is paused' }] }),
    );

    const { ok, error } = await graphqlBackend.containers.action('stop', 'abc');

    expect(ok).toBe(false);
    expect(error).toBe('Could not stop container: container is paused');
  });

  it('falls back when the request never completes', async () => {
    setBackendParam('graphql');
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network down'));

    const mode = await initBackend();

    expect(mode).toBe('php');
    expect(fallbackReason.value).toBe('The Unraid API did not respond.');
  });
});

describe('graphql container list', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The stores were written against containers.php, which passes Docker's own
  // shapes through. GraphQL cannot carry a map, so the plugin sends pairs and
  // camelCase, and this is the one place that turns them back.
  it('rebuilds the shapes the stores read', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          dockerFoldersContainerList: {
            containers: [
              {
                id: 'abc', name: 'plex', image: 'plexinc/pms-docker', state: 'running',
                status: 'Up', command: '/init', created: 1, networkMode: 'bridge',
                privileged: false, capAdd: [], exposedPorts: ['32400/tcp'], user: '',
                imageUser: '', puid: '99', pgid: '100', umask: '', icon: null,
                managed: 'dockerman', webui: null, autostart: true, autostartDelay: 0,
                ports: [
                  { ip: '0.0.0.0', privatePort: 32400, publicPort: 32400, type: 'tcp' },
                  { ip: null, privatePort: 1900, publicPort: null, type: 'udp' },
                ],
                hostPorts: [],
                mounts: [{ type: 'bind', source: '/mnt/user/media', destination: '/media', rw: false }],
                networkSettings: [{ name: 'bridge', ipAddress: '172.17.0.2' }],
                labels: [{ key: 'com.docker.compose.project', value: 'media' }],
              },
            ],
            dismissals: [{ containerName: 'plex', findingType: 'host-network' }],
          },
        },
      }),
    );

    const { ok, data } = await graphqlBackend.containers.list();

    expect(ok).toBe(true);
    const [plex] = data.containers ?? [];
    expect(plex.labels).toEqual({ 'com.docker.compose.project': 'media' });
    expect(plex.networkSettings).toEqual({ bridge: { IPAddress: '172.17.0.2' } });
    expect(plex.mounts).toEqual([
      { Type: 'bind', Source: '/mnt/user/media', Destination: '/media', RW: false },
    ]);
    // An unpublished port has no IP or PublicPort at all, as in Docker's JSON.
    expect(plex.ports[1]).toEqual({ PrivatePort: 1900, Type: 'udp' });
    expect(data.dismissals).toEqual([{ container_name: 'plex', finding_type: 'host-network' }]);
  });

  // The plugin does not own the update-check cron line yet, so these two
  // must still reach PHP, which rewrites it.
  it('sends the cron-backed settings to PHP', async () => {
    vi.mocked(apiFetch).mockResolvedValue(gqlResponse({}));

    await graphqlBackend.settings.set('update_check_schedule', 'daily');

    expect(String(vi.mocked(apiFetch).mock.calls[0][0])).toContain('settings.php');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('graphql updates, stats and container extras', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('maps a cached update row onto the snake_case shape updates.php answers with', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          dockerFoldersImageUpdates: [
            {
              image: 'linuxserver/plex:latest',
              localDigest: 'sha256:aaa',
              remoteDigest: 'sha256:bbb',
              updateAvailable: true,
              checkedAt: 1_700_000_000,
              error: null,
              sourceUrl: 'https://github.com/linuxserver/docker-plex',
              sourceRepo: 'linuxserver/docker-plex',
              release: {
                tag: 'v1.2.3',
                name: 'Plex 1.2.3',
                publishedAt: 1_699_000_000,
                url: 'https://github.com/linuxserver/docker-plex/releases/v1.2.3',
                summary: 'Bug fixes',
                fetchedAt: 1_699_500_000,
              },
            },
          ],
        },
      }),
    );

    const { ok, data } = await graphqlBackend.updates.getCached();

    expect(ok).toBe(true);
    expect(data.updates?.['linuxserver/plex:latest']).toEqual({
      image: 'linuxserver/plex:latest',
      local_digest: 'sha256:aaa',
      remote_digest: 'sha256:bbb',
      update_available: true,
      checked_at: 1_700_000_000,
      error: null,
      source_url: 'https://github.com/linuxserver/docker-plex',
      source_repo: 'linuxserver/docker-plex',
      release: {
        tag: 'v1.2.3',
        name: 'Plex 1.2.3',
        published_at: 1_699_000_000,
        url: 'https://github.com/linuxserver/docker-plex/releases/v1.2.3',
        summary: 'Bug fixes',
        fetched_at: 1_699_500_000,
      },
    });
  });

  it('reports why a cached-updates read failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Cannot query field "dockerFoldersImageUpdates"' }], data: null }),
    );

    const { ok, error } = await graphqlBackend.updates.getCached();

    expect(ok).toBe(false);
    expect(error).toBe('Cannot query field "dockerFoldersImageUpdates"');
  });

  it('sends a targeted check as the images argument and keys the result by image', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          checkDockerFoldersImageUpdates: [
            {
              image: 'plex',
              localDigest: null,
              remoteDigest: null,
              updateAvailable: false,
              checkedAt: 1_700_000_100,
              error: null,
              sourceUrl: null,
              sourceRepo: null,
              release: null,
            },
          ],
        },
      }),
    );

    const { ok, data } = await graphqlBackend.updates.check({ images: ['plex'] });

    expect(ok).toBe(true);
    expect(data.updates?.plex.release).toBeNull();
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ images: ['plex'] });
  });

  it('reports why a check failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Registry rate limit exceeded' }], data: null }),
    );

    const { ok, error } = await graphqlBackend.updates.check();

    expect(ok).toBe(false);
    expect(error).toBe('Registry rate limit exceeded');
  });

  it('turns the {id, stats} list into the Record<id, stats|null> the stats store reads', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          dockerFoldersContainerStats: [
            {
              id: 'abc',
              stats: {
                cpuPercent: 1.5,
                memoryUsage: 1024,
                memoryLimit: 2048,
                memoryPercent: 50,
                blockRead: 0,
                blockWrite: 0,
                netRx: 0,
                netTx: 0,
                pids: 3,
                restartCount: 0,
                startedAt: '2024-01-01T00:00:00Z',
                imageSize: 100,
                logSize: 10,
              },
            },
            { id: 'def', stats: null },
          ],
        },
      }),
    );

    const { ok, data } = await graphqlBackend.stats.get(['abc', 'def']);

    expect(ok).toBe(true);
    expect(data.stats?.abc?.cpuPercent).toBe(1.5);
    expect(data.stats?.def).toBeNull();
  });

  it('reports why a stats read failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Invalid CSRF token' }], data: null }),
    );

    const { ok, error } = await graphqlBackend.stats.get(['abc']);

    expect(ok).toBe(false);
    expect(error).toBe('Invalid CSRF token');
  });

  it('maps a log read and sends the container name as the id argument', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ data: { dockerFoldersContainerLogs: { logs: 'line one\nline two', error: false, message: null } } }),
    );

    const { ok, data } = await graphqlBackend.containers.logs('plex', 50);

    expect(ok).toBe(true);
    expect(data).toEqual({ logs: 'line one\nline two', error: false, message: undefined });
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ id: 'plex', tail: 50 });
  });

  it('reports why a log read failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Container not found' }], data: null }),
    );

    const { ok, error } = await graphqlBackend.containers.logs('plex', 50);

    expect(ok).toBe(false);
    expect(error).toBe('Container not found');
  });

  it('answers autostart the same shape containers.php does', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: { setDockerFoldersAutostart: { success: true, autostart: true, autostartDelay: 10 } },
      }),
    );

    const { ok, data } = await graphqlBackend.containers.setAutostart('plex', { enabled: true, delay: 10 });

    expect(ok).toBe(true);
    expect(data).toEqual({ success: true, autostart: true, autostartDelay: 10 });
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ name: 'plex', enabled: true, delay: 10 });
  });

  it('keeps autostartDelay null rather than dropping it, matching PHP\'s jsonResponse body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: { setDockerFoldersAutostart: { success: true, autostart: false, autostartDelay: null } },
      }),
    );

    const { data } = await graphqlBackend.containers.setAutostart('plex', { enabled: false });

    expect(data).toEqual({ success: true, autostart: false, autostartDelay: null });
    expect('autostartDelay' in data).toBe(true);
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ name: 'plex', enabled: false, delay: null });
  });

  it('reports why an autostart write failed', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Invalid container name' }], data: null }),
    );

    const { ok, error } = await graphqlBackend.containers.setAutostart('bad name', { enabled: true });

    expect(ok).toBe(false);
    expect(error).toBe('Invalid container name');
  });

  it('rebuilds adopt fields as a flat map and configs back to PascalCase', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({
        data: {
          dockerFoldersAdoptFields: {
            fields: [
              { key: 'contName', value: 'plex' },
              { key: 'contTag', value: 'latest' },
            ],
            configs: [
              {
                name: 'Config-1',
                target: '/config',
                default: '',
                mode: 'rw',
                description: '',
                type: 'Path',
                display: 'always',
                required: 'false',
                mask: 'false',
                value: '/mnt/user/appdata/plex',
              },
            ],
            unmapped: ['SomeSetting'],
            imageEnvKnown: true,
            portsPublished: true,
            networkDriver: 'bridge',
            managed: 'dockerman',
          },
        },
      }),
    );

    const { ok, data } = await graphqlBackend.containers.adoptFields('plex');

    expect(ok).toBe(true);
    expect(data.fields).toEqual({ contName: 'plex', contTag: 'latest' });
    expect(data.configs?.[0]).toEqual({
      Name: 'Config-1',
      Target: '/config',
      Default: '',
      Mode: 'rw',
      Description: '',
      Type: 'Path',
      Display: 'always',
      Required: 'false',
      Mask: 'false',
      Value: '/mnt/user/appdata/plex',
    });
    expect(data.unmapped).toEqual(['SomeSetting']);
    expect(data.managed).toBe('dockerman');
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables).toEqual({ id: 'plex' });
  });

  it('gives the store a message when adoptFields fails', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      gqlResponse({ errors: [{ message: 'Container not found' }], data: null }),
    );

    const { ok, error, data } = await graphqlBackend.containers.adoptFields('missing');

    expect(ok).toBe(false);
    expect(error).toBe('Container not found');
    expect(data.message).toBe('Container not found');
  });
});
