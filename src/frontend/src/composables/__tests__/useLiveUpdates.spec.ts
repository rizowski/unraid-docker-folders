import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so the mutable state they read
// has to be created with vi.hoisted to exist by the time they run.
const mocks = vi.hoisted(() => ({
  fetchContainers: vi.fn(),
  fetchFolders: vi.fn(),
  fetchStacks: vi.fn(),
  fetchCachedUpdates: vi.fn(),
  fetchSchedules: vi.fn(),
  enableUpdateChecks: true,
  backendKind: 'php' as 'php' | 'graphql',
}));

vi.mock('@/stores/docker', () => ({
  useDockerStore: () => ({ fetchContainers: mocks.fetchContainers }),
}));
vi.mock('@/stores/folders', () => ({
  useFolderStore: () => ({ fetchFolders: mocks.fetchFolders }),
}));
vi.mock('@/stores/compose', () => ({
  useComposeStore: () => ({ fetchStacks: mocks.fetchStacks }),
}));
vi.mock('@/stores/updates', () => ({
  useUpdatesStore: () => ({ fetchCachedUpdates: mocks.fetchCachedUpdates }),
}));
vi.mock('@/stores/schedules', () => ({
  useScheduleStore: () => ({ fetchSchedules: mocks.fetchSchedules }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: () => ({ enableUpdateChecks: mocks.enableUpdateChecks }),
}));
vi.mock('@/backends', () => ({
  useBackend: () => ({ kind: mocks.backendKind }),
}));
vi.mock('@/utils/csrf', () => ({
  getCsrfToken: () => 'test-token',
}));

/**
 * A stand-in for the browser `WebSocket`, shared by nchan and the (real,
 * unmocked) `GraphqlWsClient`. Distinguishing instances by `url` is enough to
 * tell the two transports apart.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly protocol?: string,
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data });
  }

  triggerClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function findSocket(pathFragment: string): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((instance) => instance.url.includes(pathFragment));
  if (socket === undefined) throw new Error(`no socket opened for ${pathFragment}`);
  return socket;
}

const originalWebSocket = globalThis.WebSocket;
let liveUpdates: typeof import('../useLiveUpdates') | null = null;

async function loadLiveUpdates() {
  liveUpdates = await import('../useLiveUpdates');
  return liveUpdates;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.backendKind = 'php';
  mocks.enableUpdateChecks = true;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  liveUpdates = null;
});

afterEach(() => {
  liveUpdates?.destroyLiveUpdates();
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
});

describe('initLiveUpdates', () => {
  it('opens only the nchan socket in php mode', async () => {
    mocks.backendKind = 'php';
    const { initLiveUpdates } = await loadLiveUpdates();

    initLiveUpdates();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain('/sub/docker-modern');
  });

  it('opens only the graphql socket in graphql mode', async () => {
    mocks.backendKind = 'graphql';
    const { initLiveUpdates } = await loadLiveUpdates();

    initLiveUpdates();

    // Every GraphQL-mode write publishes on the subscription, so nchan would
    // only carry duplicates.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(() => findSocket('/graphql')).not.toThrow();
  });
});

describe('nchan dispatch', () => {
  it('refetches folders on a folder event and containers on a container event', async () => {
    const { initLiveUpdates } = await loadLiveUpdates();
    initLiveUpdates();
    const nchan = findSocket('/sub/docker-modern');
    nchan.triggerOpen();

    nchan.triggerMessage(
      JSON.stringify({ type: 'event', entity: 'folder', action: 'update', timestamp: 1 }),
    );
    expect(mocks.fetchFolders).toHaveBeenCalledTimes(1);
    expect(mocks.fetchContainers).not.toHaveBeenCalled();

    nchan.triggerMessage(
      JSON.stringify({ type: 'event', entity: 'container', action: 'update', timestamp: 2 }),
    );
    expect(mocks.fetchContainers).toHaveBeenCalledTimes(1);
  });
});

describe('graphql subscription dispatch', () => {
  it('refetches containers and marks the connection live on a container event', async () => {
    mocks.backendKind = 'graphql';
    const { initLiveUpdates, useLiveUpdates } = await loadLiveUpdates();
    initLiveUpdates();
    const gql = findSocket('/graphql');

    gql.triggerOpen();
    gql.triggerMessage(JSON.stringify({ type: 'connection_ack' }));
    gql.triggerMessage(
      JSON.stringify({
        type: 'next',
        id: '1',
        payload: { data: { dockerFoldersEvents: { entity: 'container', action: 'update', timestamp: 1 } } },
      }),
    );

    expect(mocks.fetchContainers).toHaveBeenCalledTimes(1);
    expect(useLiveUpdates().connectionStatus.value).toBe('connected');
  });
});

