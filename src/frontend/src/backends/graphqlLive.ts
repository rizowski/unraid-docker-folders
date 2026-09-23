/**
 * GraphQL implementation of `Backend.live`: the stats and log subscriptions
 * that replace polling in GraphQL mode. See the plugin's
 * `container-extras.resolver.ts` for the subscriptions themselves.
 *
 * One socket per stream, the same pattern `graphqlStreams.ts` uses.
 * `GraphqlWsClient` has no way to end one subscription and keep the socket,
 * and a stream here ends whenever its caller's inputs change (the stats
 * store reopens its stream when the set of watched containers changes). A
 * new socket per stream costs one handshake, and closing it is the whole
 * teardown: the server unsubscribes when the socket goes away.
 */

import type { ContainerStats } from '@/stores/stats';
import { getCsrfToken } from '@/utils/csrf';
import { GraphqlWsClient } from '@/utils/graphqlWs';
import type { Backend, LiveHandlers } from './types';

const STATS_STREAM_SUBSCRIPTION = `
  subscription DockerFoldersContainerStatsStream($ids: [String!]!, $intervalMs: Int) {
    dockerFoldersContainerStatsStream(ids: $ids, intervalMs: $intervalMs) {
      id
      stats {
        cpuPercent memoryUsage memoryLimit memoryPercent blockRead blockWrite
        netRx netTx pids restartCount startedAt imageSize logSize
      }
    }
  }
`;

const LOG_STREAM_SUBSCRIPTION = `
  subscription DockerFoldersContainerLogStream($id: String!, $tail: Int) {
    dockerFoldersContainerLogStream(id: $id, tail: $tail) {
      logs
      error
      message
    }
  }
`;

const COMPOSE_LOG_STREAM_SUBSCRIPTION = `
  subscription DockerFoldersComposeLogStream($project: String!, $tail: Int) {
    dockerFoldersComposeLogStream(project: $project, tail: $tail) {
      output
    }
  }
`;

interface GqlStatsEntry {
  id: string;
  stats: ContainerStats | null;
}

interface GqlLogs {
  logs: string;
  error: boolean;
  message: string | null;
}

interface GqlComposeLogChunk {
  output: string;
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/graphql`;
}

/**
 * Open one subscription on its own socket. Returns the function that closes
 * it. After that function runs, or after `onEnd`, no handler is called again.
 */
function openLive<Field, T>(
  query: string,
  variables: Record<string, unknown>,
  fieldName: string,
  map: (field: Field) => T,
  handlers: LiveHandlers<T>,
): () => void {
  let ended = false;

  const end = (error?: string): void => {
    if (ended) return;
    ended = true;
    client.close();
    handlers.onEnd(error);
  };

  const client = new GraphqlWsClient(wsUrl(), { 'x-csrf-token': getCsrfToken() }, {
    onClosed: (reason) => end(`Live update connection closed: ${reason}`),
  });

  client.subscribe({
    query,
    variables,
    onData: (data) => {
      if (ended) return;
      const field = (data as Record<string, Field | undefined>)[fieldName];
      if (field !== undefined) handlers.onData(map(field));
    },
    onError: (message) => end(message),
    onComplete: () => end(),
  });

  client.connect();

  return () => {
    ended = true;
    client.close();
  };
}

export const graphqlLive: NonNullable<Backend['live']> = {
  stats: (ids, intervalMs, handlers) =>
    openLive<GqlStatsEntry[], Record<string, ContainerStats | null>>(
      STATS_STREAM_SUBSCRIPTION,
      { ids, intervalMs },
      'dockerFoldersContainerStatsStream',
      (entries) => Object.fromEntries(entries.map((entry) => [entry.id, entry.stats])),
      handlers,
    ),

  logs: (name, tail, handlers) =>
    openLive<GqlLogs, { logs: string; error: boolean; message?: string }>(
      LOG_STREAM_SUBSCRIPTION,
      { id: name, tail },
      'dockerFoldersContainerLogStream',
      (field) => ({ logs: field.logs, error: field.error, message: field.message ?? undefined }),
      handlers,
    ),

  composeLogs: (project, tail, handlers) =>
    openLive<GqlComposeLogChunk, { output: string }>(
      COMPOSE_LOG_STREAM_SUBSCRIPTION,
      { project, tail },
      'dockerFoldersComposeLogStream',
      (field) => ({ output: field.output }),
      handlers,
    ),
};
