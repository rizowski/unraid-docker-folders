import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/utils/csrf', () => ({
  getCsrfToken: vi.fn(() => 'test-token'),
}));

import { graphqlStreams } from '../graphqlStreams';

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

describe('graphqlStreams.pull', () => {
  it('subscribes with the given image/containerIds/recreate and delivers parsed events in order', async () => {
    const onEvent = vi.fn();
    const controller = new AbortController();

    const promise = graphqlStreams.pull('plex', { containerIds: ['abc'], recreate: true }, onEvent, controller.signal);

    const socket = FakeWebSocket.instances[0];
    socket.ready();

    const sent = JSON.parse(socket.sent[1]);
    expect(sent.type).toBe('subscribe');
    expect(sent.payload.variables).toEqual({ image: 'plex', containerIds: ['abc'], recreate: true });

    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { data: { dockerFoldersImagePullEvents: { event: 'status', data: JSON.stringify({ message: 'Pulling...' }) } } },
    });
    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { data: { dockerFoldersImagePullEvents: { event: 'done', data: JSON.stringify({ finished: true }) } } },
    });
    // The server ends the subscription once its own async iterator finishes —
    // GraphqlWsClient treats the last subscription's 'complete' as a socket
    // close, which is what resolves this promise.
    socket.triggerMessage({ type: 'complete', id: '1' });

    await expect(promise).resolves.toBeUndefined();
    expect(onEvent).toHaveBeenNthCalledWith(1, 'status', { message: 'Pulling...' });
    expect(onEvent).toHaveBeenNthCalledWith(2, 'done', { finished: true });
  });

  it('defaults containerIds/recreate to null when not given', async () => {
    const promise = graphqlStreams.pull('plex', {}, vi.fn(), new AbortController().signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    const sent = JSON.parse(socket.sent[1]);
    expect(sent.payload.variables).toEqual({ image: 'plex', containerIds: null, recreate: null });

    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { data: { dockerFoldersImagePullEvents: { event: 'done', data: '{"finished":true}' } } },
    });
    socket.triggerMessage({ type: 'complete', id: '1' });
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('graphqlStreams.compose', () => {
  it('subscribes with project/action/forceRecreate', async () => {
    const promise = graphqlStreams.compose('demo', 'up', { forceRecreate: true }, vi.fn(), new AbortController().signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    const sent = JSON.parse(socket.sent[1]);
    expect(sent.payload.variables).toEqual({ project: 'demo', action: 'up', forceRecreate: true });

    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { data: { dockerFoldersComposeStream: { event: 'done', data: '{"finished":true}' } } },
    });
    socket.triggerMessage({ type: 'complete', id: '1' });
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('runSubscriptionStream (via graphqlStreams) — settling', () => {
  it('rejects, not silently finishes, on a refused subscription (next carrying errors)', async () => {
    const onEvent = vi.fn();
    const promise = graphqlStreams.compose('demo', 'up', {}, onEvent, new AbortController().signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { errors: [{ message: 'Compose management is disabled' }] },
    });

    await expect(promise).rejects.toThrow('Compose management is disabled');
    expect(onEvent).not.toHaveBeenCalled();
    // The refusal must close this dedicated socket rather than leaving it open.
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('rejects when the connection drops before a done event was ever seen', async () => {
    const promise = graphqlStreams.pull('plex', {}, vi.fn(), new AbortController().signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { data: { dockerFoldersImagePullEvents: { event: 'progress', data: '{}' } } },
    });
    socket.triggerClose(1006, 'connection lost');

    await expect(promise).rejects.toThrow(/connection lost/);
  });

  it('resolves once a done event was seen even if it settles via the socket closing', async () => {
    const promise = graphqlStreams.pull('plex', {}, vi.fn(), new AbortController().signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    socket.triggerMessage({
      type: 'next',
      id: '1',
      payload: { data: { dockerFoldersImagePullEvents: { event: 'done', data: '{"finished":true}' } } },
    });
    socket.triggerClose(1006, 'connection lost after done');

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects with an AbortError and closes the socket when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = graphqlStreams.pull('plex', {}, vi.fn(), controller.signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('rejects immediately with an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(graphqlStreams.pull('plex', {}, vi.fn(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('settles only once even if onError and onClosed both fire', async () => {
    const promise = graphqlStreams.compose('demo', 'up', {}, vi.fn(), new AbortController().signal);
    const socket = FakeWebSocket.instances[0];
    socket.ready();

    socket.triggerMessage({ type: 'next', id: '1', payload: { errors: [{ message: 'refused' }] } });
    // The protocol's own follow-up 'complete' after an errored next frame —
    // must not also try to resolve/reject a second time.
    socket.triggerMessage({ type: 'complete', id: '1' });

    await expect(promise).rejects.toThrow('refused');
  });
});
