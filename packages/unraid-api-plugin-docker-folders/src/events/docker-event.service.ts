import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { DOCKER_CLIENT_TOKEN, type DockerClient } from '../containers/docker-client.js';
import { EventBusService } from './event-bus.service.js';

/**
 * Which Docker events mean "the container list changed".
 *
 * Docker emits far more than this. The ones left out are the reason the list
 * exists: a container with a healthcheck emits `exec_create` and `exec_start`
 * on every probe, which is every thirty seconds by default, so an unfiltered
 * stream on a server with thirty such containers would ask every open tab to
 * refetch the whole container list about twice a second, forever. That is
 * worse than the polling this replaces.
 *
 * `health_status` is kept, because a container going unhealthy is a state
 * change a user wants to see. Docker reports it as `health_status: healthy`,
 * so the match is on the prefix.
 */
const WATCHED_ACTIONS = [
    'create',
    'destroy',
    'die',
    'health_status',
    'kill',
    'oom',
    'pause',
    'rename',
    'restart',
    'start',
    'stop',
    'unpause',
    'update',
];

/**
 * How long to wait before reconnecting to the event stream.
 *
 * Docker restarting is the usual reason the stream ends, and it is back in a
 * few seconds. The backoff doubles to a ceiling so that a socket that is gone
 * for good does not spin.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Docker bursts. `docker compose up` on a ten-service stack emits create and
 * start for each one inside a second, and every one of them says the same
 * thing: refetch the list. Coalescing here cuts that to one message for every
 * subscriber at once, which the frontend cannot do for anybody but itself.
 */
const COALESCE_MS = 250;

/**
 * Turns Docker's own event stream into plugin events.
 *
 * This is what replaces polling for container state. PHP has never had it:
 * `containers.php` publishes only for actions the user took through the
 * plugin, so a container started from the Unraid webgui, from the CLI or by
 * its own restart policy was invisible until the thirty-second poll. Watching
 * the socket catches all of them.
 *
 * The stream is deliberately not a hard dependency. Docker can be stopped
 * while the API runs, and a plugin that threw on boot in that state would take
 * the folder queries down with it, which are served from SQLite and do not
 * need Docker at all. So a failure here logs and retries.
 */
@Injectable()
export class DockerEventService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(DockerEventService.name);
    private stream: NodeJS.ReadableStream | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private coalesceTimer: NodeJS.Timeout | null = null;
    private pendingAction: string | null = null;
    private attempt = 0;
    private stopped = false;
    /** Partial line left over from the previous chunk. */
    private buffer = '';

    constructor(
        @Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerClient,
        private readonly events: EventBusService
    ) {}

    onModuleInit(): void {
        void this.connect();
    }

    onModuleDestroy(): void {
        this.stopped = true;
        this.clearTimers();
        this.destroyStream();
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;

        try {
            // Filtered on Docker's side, so the noisy events never cross the
            // socket at all.
            const stream = await this.docker.getEvents({
                filters: { type: ['container'], event: WATCHED_ACTIONS },
            });

            this.stream = stream;
            this.attempt = 0;
            this.buffer = '';
            this.logger.log('Watching Docker events');

            stream.on('data', (chunk: Buffer) => this.onChunk(chunk));
            // Both of these must be attached. An unhandled 'error' on a stream
            // is an uncaught exception in Node, and this one lives inside the
            // API process, so a Docker restart would take the whole API down.
            stream.on('error', (error: Error) => this.onDisconnect(error.message));
            stream.on('end', () => this.onDisconnect('stream ended'));
            stream.on('close', () => this.onDisconnect('stream closed'));
        } catch (error) {
            this.onDisconnect(String(error));
        }
    }

    private onChunk(chunk: Buffer): void {
        // Docker sends newline-delimited JSON, and a chunk can split an object
        // in half, so the tail is carried into the next one.
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (line.trim() === '') continue;
            try {
                const event = JSON.parse(line) as { Action?: string };
                // The prefix, because Docker writes `health_status: healthy`.
                const action = (event.Action ?? 'event').split(':')[0].trim();
                this.schedule(action);
            } catch {
                // A line we cannot read is not worth failing the stream over.
            }
        }
    }

    private schedule(action: string): void {
        this.pendingAction = action;
        if (this.coalesceTimer !== null) return;

        this.coalesceTimer = setTimeout(() => {
            this.coalesceTimer = null;
            const pending = this.pendingAction ?? 'event';
            this.pendingAction = null;
            this.events.publish('container', pending);
        }, COALESCE_MS);
    }

    private onDisconnect(reason: string): void {
        if (this.stopped || this.stream === null) return;

        this.destroyStream();
        this.logger.warn(`Docker event stream lost (${reason}), reconnecting`);

        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }

    private destroyStream(): void {
        const stream = this.stream;
        this.stream = null;
        if (stream === null) return;

        stream.removeAllListeners();
        (stream as { destroy?: () => void }).destroy?.();
    }

    private clearTimers(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.coalesceTimer !== null) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = null;
        }
    }
}
