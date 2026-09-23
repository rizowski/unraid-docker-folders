import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';

import { LogStreamDecoder, clampTail, formatLogStream } from './container-logs.js';
import { detectServerTimezone } from '../util/timezone.js';
import { DOCKER_CLIENT_TOKEN, type DockerFoldersExtraDockerClient } from './extras-docker-client.js';

/**
 * `GET /containers/{id}/logs`, ported from `containers.php`'s `logs` branch
 * and `DockerClient::getContainerLogs`.
 *
 * A Docker-refused read (no socket, an unreadable logging driver, an id that
 * does not exist) is reported in the return value, never thrown. `containers.php`
 * is deliberate about this (see the comment above its `$logs === false`
 * branch): the log pane polls on a timer, so a container with an unreadable
 * logging driver would otherwise fail a request every tick. The GraphQL query
 * always resolves; `error`/`message` are how the caller tells the two apart,
 * exactly as the REST body's `error` boolean does.
 */
export interface ContainerLogsResult {
    logs: string;
    error: boolean;
    message: string | null;
}

/** Docker attaches this to a rejected request when it has one. Not exported by dockerode's types. */
interface DockerError {
    statusCode?: number;
    message?: string;
}

/**
 * How long `logStream` waits, after a line completes, for more lines before
 * emitting what it has. Applies identically to the very first batch (the
 * container's tail) and to every later batch of newly-written lines — see
 * `logStream`'s doc comment for why there is no separate "first emission"
 * code path.
 */
const LOG_STREAM_COALESCE_MS = 150;

@Injectable()
export class ContainerLogsService {
    private readonly logger = new Logger(ContainerLogsService.name);

    constructor(@Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerFoldersExtraDockerClient) {}

    async getLogs(id: string, tail?: number | null): Promise<ContainerLogsResult> {
        const effectiveTail = clampTail(tail);

        let raw: Buffer;
        try {
            const response = await this.docker.getContainer(id).logs({
                stdout: true,
                stderr: true,
                timestamps: true,
                tail: effectiveTail,
                follow: false,
            });
            // The type says Buffer; this is cheap insurance in case a
            // docker-modem version hands back a string instead (observed
            // upstream when the response body fails its own JSON-vs-raw
            // sniffing). `formatLogStream`'s `readUInt32BE` calls would throw
            // on a string, turning a parsing quirk into an unhandled 500.
            raw = Buffer.isBuffer(response) ? response : Buffer.from(String(response), 'utf8');
        } catch (error) {
            return this.refused(id, error);
        }

        if (raw.length === 0) {
            return { logs: '', error: false, message: null };
        }

        return { logs: formatLogStream(raw, detectServerTimezone()), error: false, message: null };
    }

    /**
     * The live-follow counterpart to `getLogs`, for the `dockerFoldersContainerLogStream`
     * GraphQL subscription (built by the caller around this Observable — see
     * `observable-to-async-iterator.ts`). Cold: nothing happens until
     * subscribed, and subscribing opens a real Docker follow request.
     *
     * Approach taken, and why: the obvious-looking design is two Docker
     * calls — one non-follow `getLogs()` for the initial tail, then a second
     * `follow: true` call for what comes after, stitched together with
     * `since` set to the moment the first call was made. That is wrong in a
     * subtle way: Docker's `since` filter is second-granularity, so any line
     * written in the same second as the snapshot would appear in both
     * responses, and de-duplicating that reliably means comparing log lines
     * by content, which is fragile (two genuinely identical lines a second
     * apart would look like a dup).
     *
     * Instead this opens exactly ONE `follow: true` call, with `tail` set to
     * the same clamped value `getLogs` would use. Docker itself delivers the
     * requested tail followed by everything written after — there is no
     * separate snapshot to reconcile. `LogStreamDecoder` turns that single
     * byte stream into individual formatted lines regardless of which part
     * of Docker's response they came from, and this method's only job is to
     * batch those lines into emissions: every line that completes within
     * `LOG_STREAM_COALESCE_MS` of the first still-unflushed line in a batch
     * goes out together, newest-first-joined, in the same envelope shape as
     * `getLogs`. The very first such batch is, by construction, the
     * container's tail — formatted exactly as `getLogs(id, tail)` would
     * format the same bytes, because both paths end in the same
     * `formatOneLine`/newest-first-join steps — so there is no separate
     * "first emission" branch to keep in sync with `getLogs`.
     *
     * The first batch is always sent, even when it is empty. Its timer
     * starts when Docker answers, so a container with no log output still
     * gets `{logs: '', error: false, message: null}`, the same answer
     * `getLogs` gives, and the pane stops showing its loading state. Every
     * later batch is sent only when it has lines.
     *
     * Subscribing twice starts two independent Docker follow requests —
     * there is no replay and no dedup between subscribers, the same as
     * `UpdatesService.pullImageEvents`.
     */
    logStream(id: string, tail?: number | null): Observable<ContainerLogsResult> {
        const effectiveTail = clampTail(tail);

        return new Observable<ContainerLogsResult>((subscriber) => {
            let unsubscribed = false;
            let stream: NodeJS.ReadableStream | null = null;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const decoder = new LogStreamDecoder(detectServerTimezone());
            let pendingLines: string[] = [];
            let sentFirst = false;

            const clearFlushTimer = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
            };

            // Emits an empty batch only as the first one: called both from
            // the coalescing timer and from the stream's `end` handler, and a
            // container can legitimately end with nothing newly buffered.
            const flush = () => {
                clearFlushTimer();
                if (pendingLines.length === 0 && sentFirst) {
                    return;
                }
                sentFirst = true;
                const lines = pendingLines;
                pendingLines = [];
                subscriber.next({ logs: lines.slice().reverse().join('\n'), error: false, message: null });
            };

            // A single timer per in-flight batch, not reset on every new
            // line: resetting on each line would starve the flush entirely
            // for a container that never goes 150ms without writing.
            const scheduleFlush = () => {
                if (timer !== null) {
                    return;
                }
                timer = setTimeout(flush, LOG_STREAM_COALESCE_MS);
            };

            const destroyStream = () => {
                clearFlushTimer();
                if (!stream) {
                    return;
                }
                const destroyable = stream as unknown as {
                    destroy?: () => void;
                    removeAllListeners?: (event?: string | symbol) => void;
                };
                // Call through `destroyable.destroy(...)`, not a variable
                // holding the bare function: a real Node stream's `destroy`
                // reads `this._writableState`, so an unbound call (`const d =
                // destroyable.destroy; d()`) throws.
                if (typeof destroyable.destroy === 'function') {
                    destroyable.destroy();
                } else {
                    destroyable.removeAllListeners?.();
                }
            };

            this.docker
                .getContainer(id)
                .logs({ stdout: true, stderr: true, timestamps: true, tail: effectiveTail, follow: true })
                .then((liveStream) => {
                    if (unsubscribed) {
                        // Teardown already ran while this promise was still
                        // pending; there was nothing to destroy() yet, so do
                        // it now instead of leaking the socket.
                        const destroyable = liveStream as unknown as { destroy?: () => void };
                        destroyable.destroy?.();
                        return;
                    }

                    stream = liveStream;
                    // Starts the first batch's window now, so it is sent
                    // even if the container has nothing to show.
                    scheduleFlush();

                    liveStream.on('data', (chunk: Buffer) => {
                        const newLines = decoder.push(chunk);
                        if (newLines.length > 0) {
                            pendingLines.push(...newLines);
                            scheduleFlush();
                        }
                    });

                    liveStream.on('end', () => {
                        flush();
                        subscriber.complete();
                    });

                    liveStream.on('error', (error: unknown) => {
                        clearFlushTimer();
                        pendingLines = [];
                        subscriber.next(this.refused(id, error));
                        subscriber.complete();
                    });
                })
                .catch((error: unknown) => {
                    if (unsubscribed) {
                        return;
                    }
                    subscriber.next(this.refused(id, error));
                    subscriber.complete();
                });

            return () => {
                unsubscribed = true;
                destroyStream();
                this.logger.debug(`Closed follow log stream for container ${id}`);
            };
        });
    }

    /**
     * Same envelope `containers.php` returns on a `$logs === false`: empty
     * logs, `error: true`, and a message. A 400 specifically means the
     * container's logging driver can't be read back (`--log-driver=none`,
     * `syslog`, ...) — the only layer that knows which endpoint was called, so
     * the explanation is attached here rather than sniffed out upstream.
     */
    private refused(id: string, error: unknown): ContainerLogsResult {
        const docker = error as DockerError | null;
        let message = docker?.message ?? (error instanceof Error ? error.message : String(error));

        if (docker?.statusCode === 400) {
            message += " — this container's logging driver may not support reading logs";
        }

        this.logger.warn(`Could not read logs for container ${id}: ${message}`);
        return { logs: '', error: true, message };
    }
}
