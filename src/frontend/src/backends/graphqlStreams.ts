/**
 * GraphQL implementation of the streaming seam (`Backend.streams`), backing
 * `dockerFoldersImagePullEvents` and `dockerFoldersComposeStream` — see the
 * plugin's `updates.resolver.ts`/`compose.resolver.ts` for the subscriptions
 * themselves.
 *
 * One dedicated `GraphqlWsClient` per call, opened and closed around exactly
 * that one subscription's lifetime — unlike the shared, long-lived socket
 * `useLiveUpdates.ts` opens for `dockerFoldersEvents`. `GraphqlWsClient`
 * documents why it offers no per-subscription unsubscribe: every one of its
 * other callers lives as long as the socket does. A streaming pull or
 * compose run does not, so it gets its own socket, closed on completion, on
 * error, or when the caller's `AbortSignal` fires. Closing the socket only
 * stops this client from receiving further events — it does not cancel the
 * server-side run. That is deliberate: `UpdatesService.pullImageEvents` and
 * `ComposeService.streamStackUp`/`streamStackPull` keep going after their
 * Observable is unsubscribed, the same way `pull.php`/`compose-stream.php`
 * keep running after the browser disconnects (`ignore_user_abort(true)`).
 */

import { getCsrfToken } from '@/utils/csrf';
import { GraphqlWsClient } from '@/utils/graphqlWs';
import type { Backend } from './types';

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/graphql`;
}

const PULL_EVENTS_SUBSCRIPTION = `
  subscription DockerFoldersImagePullEvents($image: String!, $containerIds: [String!], $recreate: Boolean) {
    dockerFoldersImagePullEvents(image: $image, containerIds: $containerIds, recreate: $recreate) {
      event
      data
    }
  }
`;

const COMPOSE_STREAM_SUBSCRIPTION = `
  subscription DockerFoldersComposeStream($project: String!, $action: String!, $forceRecreate: Boolean) {
    dockerFoldersComposeStream(project: $project, action: $action, forceRecreate: $forceRecreate) {
      event
      data
    }
  }
`;

interface StreamEventPayload {
  event: string;
  data: string;
}

/**
 * Runs one subscription to completion, mapping each item to
 * `onEvent(event, data)` — `data` is `JSON.parse`d before the caller sees
 * it, so `handleSSEEvent` never has to know which transport produced it.
 *
 * Settling:
 * - `onError` (a refused subscription — bad args, permission denied, compose
 *   management disabled — arrives this way per `GraphqlWsClient`'s doc,
 *   not as a thrown exception) rejects immediately and closes the socket, so
 *   a refusal is a visible failure rather than a silent finish.
 * - `onClosed` (the socket ended, for any reason) resolves if the stream's
 *   `'done'` event was already seen — the server-driven equivalent of PHP's
 *   `reader.read()` loop ending after `sendSSE('done', ...)` — or rejects
 *   otherwise, matching PHP's `catch` block for a connection that drops
 *   mid-stream.
 * - Aborting `signal` closes the socket and rejects with a `DOMException`
 *   named `'AbortError'`, the same shape `fetch()`'s own abort throws, so
 *   callers keep an unchanged `e.name !== 'AbortError'` check.
 *
 * Every path settles at most once; later callbacks are no-ops.
 */
function runSubscriptionStream(
  query: string,
  variables: Record<string, unknown>,
  fieldName: string,
  onEvent: (event: string, data: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawDone = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      client.close();
      fn();
    };

    const onAbort = (): void => finish(() => reject(new DOMException('Aborted', 'AbortError')));

    const client = new GraphqlWsClient(wsUrl(), { 'x-csrf-token': getCsrfToken() }, {
      onClosed: (reason) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (sawDone) {
          resolve();
        } else {
          reject(new Error(`Live update connection closed: ${reason}`));
        }
      },
    });

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);

    client.subscribe({
      query,
      variables,
      onData: (data) => {
        const payload = (data as Record<string, StreamEventPayload | undefined>)[fieldName];
        if (!payload) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.data);
        } catch {
          parsed = {};
        }

        onEvent(payload.event, parsed);
        if (payload.event === 'done') sawDone = true;
      },
      onError: (message) => finish(() => reject(new Error(message))),
    });

    client.connect();
  });
}

export const graphqlStreams: Backend['streams'] = {
  pull: (image, opts, onEvent, signal) =>
    runSubscriptionStream(
      PULL_EVENTS_SUBSCRIPTION,
      { image, containerIds: opts.containerIds ?? null, recreate: opts.recreate ?? null },
      'dockerFoldersImagePullEvents',
      onEvent,
      signal,
    ),

  compose: (project, action, opts, onEvent, signal) =>
    runSubscriptionStream(
      COMPOSE_STREAM_SUBSCRIPTION,
      { project, action, forceRecreate: opts.forceRecreate ?? null },
      'dockerFoldersComposeStream',
      onEvent,
      signal,
    ),
};
