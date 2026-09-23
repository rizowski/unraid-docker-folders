import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { request } from 'node:http';

import { nowSeconds } from '../util/time.js';

/**
 * Tells open browser tabs that something changed, the same way the PHP backend
 * means to.
 *
 * Unraid ships an nchan server and the frontend subscribes at
 * `/sub/docker-modern`. A mutation that skipped this would leave a second tab,
 * and the dashboard widget, showing stale folders until the 30-second poll.
 *
 * GraphQL subscriptions replace this later. Until then the plugin speaks the
 * channel that is already there, so both backends keep every open tab in step
 * with no frontend change at all.
 *
 * Fire and forget, with the same 2-second ceiling the PHP version uses: a
 * mutation must not fail because a notification did.
 */

/**
 * Where nchan actually accepts a publish, measured on Unraid 7.3.2.
 *
 * Not `http://localhost:4433`, which is what `config.php` has and what this
 * service copied at first. Nothing listens on 4433 on that box, so every
 * publish failed with "fetch failed" and live updates fell back to the poll.
 * `conf.d/servers.conf` puts the publisher on a Unix socket instead, and
 * `/usr/local/emhttp/plugins/dynamix/include/publish.php` is Unraid's own
 * caller, which is where the shape below comes from.
 *
 * `buffer_length` is required, not optional. The location sets
 * `nchan_message_buffer_length $arg_buffer_length`, so without the query
 * parameter the buffer length is empty and nchan answers 403. With it, 201.
 */
const NCHAN_SOCKET_PATH = '/var/run/nginx.socket';
const NCHAN_CHANNEL = 'docker-modern';
const NCHAN_PUB_PATH = `/pub/${NCHAN_CHANNEL}?buffer_length=1`;

const PUBLISH_TIMEOUT_MS = 2000;

/**
 * Unraid's own kill switch for publishing.
 *
 * `dynamix/include/publish.php` returns immediately when this file exists, and
 * Unraid creates it while it restarts nginx after nchan runs out of shared
 * memory. Publishing through a socket that is deliberately down would fail
 * once per mutation and log each one, so the check is worth the stat call.
 */
const PUBLISH_PAUSED_PATH = '/tmp/publishPaused';

@Injectable()
export class NchanService {
    private readonly logger = new Logger(NchanService.name);

    /**
     * `entity` and `action` are the only fields the frontend reads: every
     * event is a "refetch this entity" signal, not a patch. The payload stays
     * null rather than inventing a second shape for the same event PHP
     * already publishes.
     */
    publish(entity: string, action: string): void {
        if (existsSync(PUBLISH_PAUSED_PATH)) return;

        const body = JSON.stringify({
            type: 'event',
            entity,
            action,
            data: null,
            // Seconds, because `WebSocketPublisher.php` sends PHP's `time()`.
            timestamp: nowSeconds(),
        });

        // `node:http` rather than fetch, because fetch cannot address a Unix
        // socket without reaching into undici for a dispatcher.
        const call = request(
            {
                socketPath: NCHAN_SOCKET_PATH,
                path: NCHAN_PUB_PATH,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: PUBLISH_TIMEOUT_MS,
            },
            (response) => {
                const status = response.statusCode ?? 0;
                if (status >= 400) {
                    this.logger.warn(`nchan refused ${entity}/${action}: HTTP ${status}`);
                }
                // Drain, or the socket is held until it times out.
                response.resume();
            }
        );

        call.on('timeout', () => call.destroy());
        call.on('error', (error) => {
            this.logger.warn(`Could not publish ${entity}/${action}: ${String(error)}`);
        });
        call.end(body);
    }
}
