import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/csrf', () => ({
  getCsrfToken: vi.fn(() => 'test-token'),
}));

import { graphqlLive } from '../graphqlLive';

/** Same stand-in as utils/__tests__/graphqlWs.spec.ts — see that file for why. */
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

  triggerMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  triggerClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Opens the socket and completes the graphql-transport-ws handshake. */
  ready(): void {
    this.triggerOpen();
    this.triggerMessage({ type: 'connection_ack' });
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

/** The subscribe message the client sent, parsed. */
function subscribeMessage(socket: FakeWebSocket): { id: string; payload: { variables: Record<string, unknown> } } {
  const raw = socket.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'subscribe');
  return raw;
}

describe('graphqlLive.stats', () => {
  it('subscribes with the ids and interval, and maps entries to a record', () => {
    const onData = vi.fn();
    const onEnd = vi.fn();
    graphqlLive.stats(['a', 'b'], 15000, { onData, onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    expect(sub.payload.variables).toEqual({ ids: ['a', 'b'], intervalMs: 15000 });
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'connection_init', payload: { 'x-csrf-token': 'test-token' } });

    socket.triggerMessage({
      id: sub.id,
      type: 'next',
      payload: { data: { dockerFoldersContainerStatsStream: [{ id: 'a', stats: { cpuPercent: 3 } }, { id: 'b', stats: null }] } },
    });

    expect(onData).toHaveBeenCalledWith({ a: { cpuPercent: 3 }, b: null });
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('reports a dropped connection as an error end', () => {
    const onEnd = vi.fn();
    graphqlLive.stats(['a'], 5000, { onData: vi.fn(), onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    socket.triggerClose(1006, '');

    expect(onEnd).toHaveBeenCalledWith('Live update connection closed: code 1006');
  });

  it('reports a refusal with the server message', () => {
    const onEnd = vi.fn();
    graphqlLive.stats(['a'], 5000, { onData: vi.fn(), onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    socket.triggerMessage({ id: sub.id, type: 'next', payload: { errors: [{ message: 'Forbidden resource' }] } });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('Forbidden resource');
  });

  it('calls nothing after the caller closes it', () => {
    const onData = vi.fn();
    const onEnd = vi.fn();
    const close = graphqlLive.stats(['a'], 5000, { onData, onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    close();
    socket.triggerMessage({ id: sub.id, type: 'next', payload: { data: { dockerFoldersContainerStatsStream: [] } } });
    socket.triggerClose(1000, '');

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(onData).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('graphqlLive.logs', () => {
  it('subscribes by container name and passes each batch through', () => {
    const onData = vi.fn();
    graphqlLive.logs('plex', 50, { onData, onEnd: vi.fn() });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    expect(sub.payload.variables).toEqual({ id: 'plex', tail: 50 });

    socket.triggerMessage({
      id: sub.id,
      type: 'next',
      payload: { data: { dockerFoldersContainerLogStream: { logs: 'b\na', error: false, message: null } } },
    });

    expect(onData).toHaveBeenCalledWith({ logs: 'b\na', error: false, message: undefined });
  });

  it('treats the server ending the stream as a normal end', () => {
    const onEnd = vi.fn();
    graphqlLive.logs('plex', 50, { onData: vi.fn(), onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    socket.triggerMessage({ id: sub.id, type: 'complete' });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });
});

describe('graphqlLive.composeLogs', () => {
  it('subscribes by project and tail, and passes each chunk through unchanged', () => {
    const onData = vi.fn();
    graphqlLive.composeLogs('media-stack', 500, { onData, onEnd: vi.fn() });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    expect(sub.payload.variables).toEqual({ project: 'media-stack', tail: 500 });

    socket.triggerMessage({
      id: sub.id,
      type: 'next',
      payload: { data: { dockerFoldersComposeLogStream: { output: 'line one\nline two' } } },
    });

    expect(onData).toHaveBeenCalledWith({ output: 'line one\nline two' });
  });

  it('passes a later chunk through as its own call, not merged with the first', () => {
    const onData = vi.fn();
    graphqlLive.composeLogs('media-stack', 500, { onData, onEnd: vi.fn() });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);

    socket.triggerMessage({
      id: sub.id,
      type: 'next',
      payload: { data: { dockerFoldersComposeLogStream: { output: 'initial tail' } } },
    });
    socket.triggerMessage({
      id: sub.id,
      type: 'next',
      payload: { data: { dockerFoldersComposeLogStream: { output: 'new line' } } },
    });

    expect(onData).toHaveBeenNthCalledWith(1, { output: 'initial tail' });
    expect(onData).toHaveBeenNthCalledWith(2, { output: 'new line' });
  });

  it('treats the compose process exiting as a normal end', () => {
    const onEnd = vi.fn();
    graphqlLive.composeLogs('media-stack', 500, { onData: vi.fn(), onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    socket.triggerMessage({ id: sub.id, type: 'complete' });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });

  it('reports a dropped connection as an error end', () => {
    const onEnd = vi.fn();
    graphqlLive.composeLogs('media-stack', 500, { onData: vi.fn(), onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    socket.triggerClose(1006, '');

    expect(onEnd).toHaveBeenCalledWith('Live update connection closed: code 1006');
  });

  it('calls nothing after the caller closes it', () => {
    const onData = vi.fn();
    const onEnd = vi.fn();
    const close = graphqlLive.composeLogs('media-stack', 500, { onData, onEnd });

    const socket = FakeWebSocket.instances[0];
    socket.ready();
    const sub = subscribeMessage(socket);
    close();
    socket.triggerMessage({
      id: sub.id,
      type: 'next',
      payload: { data: { dockerFoldersComposeLogStream: { output: 'too late' } } },
    });
    socket.triggerClose(1000, '');

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(onData).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});
