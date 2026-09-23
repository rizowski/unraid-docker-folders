/**
 * A minimal `graphql-transport-ws` client.
 *
 * Hand-written rather than `graphql-ws`, which is the reference library. That
 * package names `graphql` as a required peer, so taking it would add the whole
 * GraphQL reference implementation to a bundle that ships on a USB stick and
 * currently has three runtime dependencies. Nothing here needs it: `graphql.ts`
 * already sends operations as plain strings over `fetch`, and the protocol
 * below is a handful of message types.
 *
 * Protocol: https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md
 *
 * Auth is the part that is easy to get wrong. The CSRF token has to be in
 * `connection_init`'s payload. Verified on Unraid 7.3.2 / API 4.35.1: with no
 * payload, and with an empty one, `subscribe` fails with "Cannot read
 * properties of undefined (reading 'csrf_token')". The websocket context
 * carries no `method`, so the API always takes its non-GET path and demands
 * the token, and its `request.query.csrf_token` fallback throws because a
 * websocket context has no query either. The session cookie rides the upgrade
 * request, which the browser sends by itself.
 *
 * A `connection_ack` says nothing about whether a subscription is allowed: the
 * permission guard runs per operation, on `subscribe`. So a caller that wants
 * to know it is really live has to wait for data or for an error, not for the
 * ack.
 *
 * Reconnection is the caller's job. This class reports that it closed and does
 * nothing else, so one backoff policy can cover both transports instead of two
 * that drift.
 */

export const GRAPHQL_WS_SUBPROTOCOL = 'graphql-transport-ws';

export interface GraphqlWsHandlers {
  /** The socket is open and the server accepted `connection_init`. */
  onReady?: () => void;
  /** The socket closed, for any reason, including a failed connect. */
  onClosed?: (reason: string) => void;
}

interface Subscription {
  query: string;
  variables?: Record<string, unknown>;
  onData: (data: unknown) => void;
  onError?: (message: string) => void;
  /** The server ended this subscription. Called before the socket is dropped. */
  onComplete?: () => void;
}

interface ServerMessage {
  type?: string;
  id?: string;
  payload?: unknown;
}

export class GraphqlWsClient {
  private socket: WebSocket | null = null;
  private ready = false;
  private closedReported = false;
  private nextId = 1;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly url: string,
    private readonly connectionParams: Record<string, string>,
    private readonly handlers: GraphqlWsHandlers = {},
  ) {}

  /** Open the socket. Subscriptions added before this are sent on ack. */
  connect(): void {
    if (this.socket !== null) return;

    this.closedReported = false;

    try {
      this.socket = new WebSocket(this.url, GRAPHQL_WS_SUBPROTOCOL);
    } catch (error) {
      this.reportClosed(String(error));
      return;
    }

    this.socket.onopen = () => {
      this.send({ type: 'connection_init', payload: this.connectionParams });
    };

    this.socket.onmessage = (event) => this.onMessage(event);
    this.socket.onerror = () => {
      // `onclose` always follows, and it carries the better reason.
    };
    this.socket.onclose = (event) => {
      this.reportClosed(event.reason || `code ${event.code}`);
    };
  }

  /**
   * Register a subscription. Returns nothing to unsubscribe with, because
   * every caller here lives as long as the socket does; `close()` ends them
   * all.
   */
  subscribe(subscription: Subscription): void {
    const id = String(this.nextId);
    this.nextId += 1;
    this.subscriptions.set(id, subscription);

    if (this.ready) this.sendSubscribe(id, subscription);
  }

  /** Close the socket without reporting it, so the caller does not reconnect. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.closedReported = true;
    this.subscriptions.clear();

    if (socket === null) return;
    socket.onclose = null;
    socket.close();
  }

  private onMessage(event: MessageEvent): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'connection_ack':
        this.ready = true;
        for (const [id, subscription] of this.subscriptions) {
          this.sendSubscribe(id, subscription);
        }
        this.handlers.onReady?.();
        break;

      // The server may ping at any time and expects a pong, or it closes the
      // socket as unresponsive.
      case 'ping':
        this.send({ type: 'pong' });
        break;

      // A rejected subscription arrives here, not in an `error` frame.
      // Measured against Unraid API 4.35.1: subscribing without the CSRF token
      // answers `next` carrying `{errors: [...]}` and then `complete`, so a
      // client that only reads `payload.data` treats a refusal as silence and
      // then loses the subscription without ever saying why.
      case 'next': {
        const subscription = message.id === undefined ? undefined : this.subscriptions.get(message.id);
        if (subscription === undefined) break;

        const payload = message.payload as { data?: unknown; errors?: unknown } | undefined;
        if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
          subscription.onError?.(firstErrorMessage(payload.errors));
          break;
        }
        if (payload?.data !== undefined) subscription.onData(payload.data);
        break;
      }

      case 'error': {
        const subscription = message.id === undefined ? undefined : this.subscriptions.get(message.id);
        subscription?.onError?.(firstErrorMessage(message.payload));
        break;
      }

      // The server ended a subscription we did not end. Nothing will ever
      // arrive on this socket again, so treat it as a disconnect and let the
      // caller's backoff reopen it. Without this the socket stays open, the
      // status stays "connected" and no event is ever delivered.
      case 'complete':
        if (message.id !== undefined) {
          const subscription = this.subscriptions.get(message.id);
          this.subscriptions.delete(message.id);
          subscription?.onComplete?.();
        }
        if (this.subscriptions.size === 0) this.endSocket('server ended the subscription');
        break;

      default:
        break;
    }
  }

  /** Drop the socket and tell the caller, so its backoff reopens one. */
  private endSocket(reason: string): void {
    const socket = this.socket;
    if (socket !== null) {
      socket.onclose = null;
      socket.close();
    }
    this.reportClosed(reason);
  }

  private sendSubscribe(id: string, subscription: Subscription): void {
    this.send({
      id,
      type: 'subscribe',
      payload: { query: subscription.query, variables: subscription.variables },
    });
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private reportClosed(reason: string): void {
    if (this.closedReported) return;
    this.closedReported = true;
    this.ready = false;
    this.socket = null;
    this.handlers.onClosed?.(reason);
  }
}

function firstErrorMessage(payload: unknown): string {
  if (Array.isArray(payload)) {
    const first = payload[0] as { message?: string } | undefined;
    if (typeof first?.message === 'string') return first.message;
  }
  return 'Subscription failed';
}
