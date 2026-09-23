import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphqlWsClient, GRAPHQL_WS_SUBPROTOCOL } from '../graphqlWs';

/**
 * A stand-in for the browser `WebSocket`. `GraphqlWsClient` never touches a
 * real socket, so the test drives the protocol by calling `triggerOpen` /
 * `triggerMessage` / `triggerClose` in place of the events a real socket
 * would fire.
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

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe('GraphqlWsClient', () => {
  it('connects with the graphql-transport-ws subprotocol', () => {
    const client = new GraphqlWsClient('ws://host/graphql', {});
    client.connect();

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://host/graphql');
    expect(socket.protocol).toBe(GRAPHQL_WS_SUBPROTOCOL);
  });

  it('sends connection_init with the connection params on open', () => {
    const client = new GraphqlWsClient('ws://host/graphql', { 'x-csrf-token': 'abc' });
    client.connect();
    FakeWebSocket.instances[0].triggerOpen();

    // This is the whole reason the class exists: the auth token has to ride
    // in connection_init's payload, exactly, or the plugin rejects subscribe.
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({
      type: 'connection_init',
      payload: { 'x-csrf-token': 'abc' },
    });
  });

  it('sends a subscription registered before connect only after the ack', () => {
    const client = new GraphqlWsClient('ws://host/graphql', {});
    client.subscribe({ query: '{ foo }', onData: vi.fn() });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    // connection_init only — the subscribe message must not jump the queue.
    expect(socket.sent).toHaveLength(1);

    socket.triggerMessage(JSON.stringify({ type: 'connection_ack' }));

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1])).toEqual({
      id: '1',
      type: 'subscribe',
      payload: { query: '{ foo }' },
    });
  });

  it('routes a next message to the matching subscription and ignores an unknown id', () => {
    const onData = vi.fn();
    const client = new GraphqlWsClient('ws://host/graphql', {});
    client.subscribe({ query: '{ foo }', onData });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    socket.triggerMessage(JSON.stringify({ type: 'connection_ack' }));

    socket.triggerMessage(JSON.stringify({ type: 'next', id: '99', payload: { data: { foo: 'nope' } } }));
    expect(onData).not.toHaveBeenCalled();

    socket.triggerMessage(JSON.stringify({ type: 'next', id: '1', payload: { data: { foo: 'bar' } } }));
    expect(onData).toHaveBeenCalledWith({ foo: 'bar' });
  });

  it('answers a server ping with a pong', () => {
    const client = new GraphqlWsClient('ws://host/graphql', {});
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    // The server closes an unresponsive socket, so a missed pong looks like a
    // dropped connection instead of a protocol bug.
    socket.triggerMessage(JSON.stringify({ type: 'ping' }));

    expect(JSON.parse(socket.sent[socket.sent.length - 1])).toEqual({ type: 'pong' });
  });

  it('calls onError with the first error message', () => {
    const onError = vi.fn();
    const client = new GraphqlWsClient('ws://host/graphql', {});
    client.subscribe({ query: '{ foo }', onData: vi.fn(), onError });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    socket.triggerMessage(JSON.stringify({ type: 'connection_ack' }));

    socket.triggerMessage(
      JSON.stringify({ type: 'error', id: '1', payload: [{ message: 'not authorized' }] }),
    );

    expect(onError).toHaveBeenCalledWith('not authorized');
  });

  it('reports a close exactly once', () => {
    const onClosed = vi.fn();
    const client = new GraphqlWsClient('ws://host/graphql', {}, { onClosed });
    client.connect();
    const socket = FakeWebSocket.instances[0];

    socket.triggerClose(1006, 'connection lost');
    socket.triggerClose(1006, 'connection lost');

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith('connection lost');
  });

  it('suppresses onClosed when the caller closes intentionally', () => {
    const onClosed = vi.fn();
    const client = new GraphqlWsClient('ws://host/graphql', {}, { onClosed });
    client.connect();
    const socket = FakeWebSocket.instances[0];

    client.close();
    // close() detaches onclose first, so a close event arriving late (as it
    // would from a real socket) finds nothing to call.
    socket.triggerClose(1000, 'client closed');

    expect(onClosed).not.toHaveBeenCalled();
  });

  it('does not throw on malformed JSON from the server', () => {
    const client = new GraphqlWsClient('ws://host/graphql', {});
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    expect(() => socket.triggerMessage('{not json')).not.toThrow();
  });

  // Measured against the live Unraid API 4.35.1, and the reason this case is
  // here at all: a subscription the permission guard refuses is not answered
  // with an `error` frame. It comes back as `next` carrying an errors array,
  // followed by `complete`. A client that reads only `payload.data` treats a
  // refusal as silence and then quietly loses the subscription.
  it('treats an errors array inside a next frame as a rejection', () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const client = new GraphqlWsClient('ws://host/graphql', { 'x-csrf-token': 't' });
    client.subscribe({ query: 'subscription { x }', onData, onError });
    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    socket.triggerMessage(JSON.stringify({ type: 'connection_ack' }));
    socket.triggerMessage(
      JSON.stringify({
        id: '1',
        type: 'next',
        payload: {
          errors: [
            {
              message:
                "Failed to validate session: Cannot read properties of undefined (reading 'csrf_token')",
            },
          ],
        },
      }),
    );

    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      "Failed to validate session: Cannot read properties of undefined (reading 'csrf_token')",
    );
  });

  // The server ending the last subscription means nothing will ever arrive on
  // this socket again. Reporting it is what lets the caller's backoff reopen
  // one instead of sitting on a live socket that is permanently silent.
  it('reports a disconnect when the server completes the last subscription', () => {
    const onClosed = vi.fn();
    const client = new GraphqlWsClient('ws://host/graphql', {}, { onClosed });
    client.subscribe({ query: 'subscription { x }', onData: vi.fn() });
    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    socket.triggerMessage(JSON.stringify({ type: 'connection_ack' }));
    socket.triggerMessage(JSON.stringify({ id: '1', type: 'complete' }));

    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
