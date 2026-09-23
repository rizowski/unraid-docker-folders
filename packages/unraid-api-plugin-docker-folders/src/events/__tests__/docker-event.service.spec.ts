import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DockerClient, DockerEventsOptions } from '../../containers/docker-client.js';
import { DockerEventService } from '../docker-event.service.js';
import type { EventBusService } from '../event-bus.service.js';

/**
 * A stand-in for dockerode's event stream.
 *
 * The real `getEvents` resolves with a Node readable backed by a live Docker
 * socket. A `PassThrough` satisfies the same `NodeJS.ReadableStream` shape and
 * lets a test push chunks straight into what the service is reading. Each
 * call makes a fresh stream, the way a reconnect would.
 */
function fakeDocker() {
    const calls: DockerEventsOptions[] = [];
    const streams: PassThrough[] = [];
    const client: DockerClient = {
        listContainers: () => Promise.reject(new Error('not used here')),
        getContainer: () => {
            throw new Error('not used here');
        },
        getImage: () => {
            throw new Error('not used here');
        },
        getEvents: async (options: DockerEventsOptions) => {
            calls.push(options);
            const stream = new PassThrough();
            streams.push(stream);
            return stream;
        },
        distributionInspect: () => Promise.reject(new Error('not used here')),
        pullImage: () => Promise.reject(new Error('not used here')),
    };
    return { client, calls, current: () => streams[streams.length - 1] };
}

function fakeEvents() {
    return { publish: vi.fn() } as unknown as EventBusService;
}

/** Lets the pending `connect()` promise, and any stream 'data' events, settle. */
async function flush() {
    await vi.advanceTimersByTimeAsync(0);
}

describe('DockerEventService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('asks Docker for container events filtered to the watched actions', async () => {
        const docker = fakeDocker();
        const service = new DockerEventService(docker.client, fakeEvents());

        service.onModuleInit();
        await flush();

        expect(docker.calls).toHaveLength(1);
        expect(docker.calls[0].filters?.type).toEqual(['container']);
        // The exclusion is the point of the filter: an unwatched action like a
        // healthcheck's exec_create would flood the coalescer.
        expect(docker.calls[0].filters?.event).toContain('start');
        expect(docker.calls[0].filters?.event).toContain('health_status');
        expect(docker.calls[0].filters?.event).not.toContain('exec_create');

        service.onModuleDestroy();
    });

    it('publishes one event after the coalesce window, and nothing before it', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        docker.current().write(`${JSON.stringify({ Action: 'start' })}\n`);
        await flush();
        expect(events.publish).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(249);
        expect(events.publish).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(events.publish).toHaveBeenCalledTimes(1);
        expect(events.publish).toHaveBeenCalledWith('container', 'start');

        service.onModuleDestroy();
    });

    it('publishes exactly once for a burst inside the coalesce window', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        // The kind of burst `docker compose up` produces for a multi-service
        // stack: several containers, each announcing create then start.
        docker.current().write(`${JSON.stringify({ Action: 'create' })}\n`);
        await flush();
        docker.current().write(`${JSON.stringify({ Action: 'start' })}\n`);
        await flush();
        docker.current().write(`${JSON.stringify({ Action: 'die' })}\n`);
        await flush();

        await vi.advanceTimersByTimeAsync(250);

        // Only the last action scheduled survives the coalesce; the point is
        // there is one refetch signal, not which action it names.
        expect(events.publish).toHaveBeenCalledTimes(1);
        expect(events.publish).toHaveBeenCalledWith('container', 'die');

        service.onModuleDestroy();
    });

    it('parses a JSON object once its two chunks are reassembled', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        const line = `${JSON.stringify({ Action: 'start' })}\n`;
        const splitAt = Math.floor(line.length / 2);
        docker.current().write(line.slice(0, splitAt));
        await flush();
        // Nothing to parse yet: the buffered half has no newline in it.
        expect(events.publish).not.toHaveBeenCalled();

        docker.current().write(line.slice(splitAt));
        await flush();
        await vi.advanceTimersByTimeAsync(250);

        expect(events.publish).toHaveBeenCalledTimes(1);
        expect(events.publish).toHaveBeenCalledWith('container', 'start');

        service.onModuleDestroy();
    });

    it('reports health_status as the action, not the full "health_status: healthy" string', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        docker.current().write(`${JSON.stringify({ Action: 'health_status: healthy' })}\n`);
        await flush();
        await vi.advanceTimersByTimeAsync(250);

        expect(events.publish).toHaveBeenCalledWith('container', 'health_status');

        service.onModuleDestroy();
    });

    it('skips a malformed line without throwing or blocking the lines after it', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        expect(() => {
            docker.current().write('not json\n');
            docker.current().write(`${JSON.stringify({ Action: 'start' })}\n`);
        }).not.toThrow();
        await flush();
        await vi.advanceTimersByTimeAsync(250);

        expect(events.publish).toHaveBeenCalledTimes(1);
        expect(events.publish).toHaveBeenCalledWith('container', 'start');

        service.onModuleDestroy();
    });

    it('reconnects after a stream error, and keeps a listener attached so it never goes unhandled', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        // An unhandled 'error' on a Node stream is an uncaught exception, so
        // this is the difference between a Docker restart and an API crash.
        expect(docker.current().listenerCount('error')).toBeGreaterThan(0);

        docker.current().emit('error', new Error('socket hang up'));
        await vi.advanceTimersByTimeAsync(1000);

        expect(docker.calls).toHaveLength(2);

        service.onModuleDestroy();
    });

    it('stops everything on destroy: no reconnect, and a pending coalesce never fires', async () => {
        const docker = fakeDocker();
        const events = fakeEvents();
        const service = new DockerEventService(docker.client, events);
        service.onModuleInit();
        await flush();

        docker.current().write(`${JSON.stringify({ Action: 'start' })}\n`);
        await flush();
        docker.current().emit('error', new Error('socket hang up'));

        service.onModuleDestroy();
        await vi.advanceTimersByTimeAsync(60_000);

        // Neither the pending coalesce nor the pending reconnect survived.
        expect(events.publish).not.toHaveBeenCalled();
        expect(docker.calls).toHaveLength(1);
    });
});
