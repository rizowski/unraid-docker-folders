import type { PubSubEngine } from 'graphql-subscriptions';
import { describe, expect, it, vi } from 'vitest';

import { EventBusService } from '../event-bus.service.js';
import { DOCKER_FOLDERS_EVENT_TOPIC } from '../event.model.js';
import type { NchanService } from '../nchan.service.js';

function fakeNchan() {
    return { publish: vi.fn() } as unknown as NchanService;
}

describe('EventBusService', () => {
    it('publishes to both nchan and the GraphQL pubsub', async () => {
        const nchan = fakeNchan();
        const pubsub = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubEngine;
        const bus = new EventBusService(nchan, pubsub);

        bus.publish('folder', 'created');
        // The pubsub call is a promise nobody awaits inside publish(), so it
        // needs a tick to actually reach the fake.
        await vi.waitFor(() => expect(pubsub.publish).toHaveBeenCalled());

        expect(nchan.publish).toHaveBeenCalledWith('folder', 'created');
    });

    it('shapes the pubsub payload as dockerFoldersEvents with a numeric timestamp', async () => {
        const nchan = fakeNchan();
        const pubsub = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubEngine;
        const bus = new EventBusService(nchan, pubsub);

        bus.publish('container', 'start');
        await vi.waitFor(() => expect(pubsub.publish).toHaveBeenCalled());

        const [topic, payload] = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0] as [
            string,
            { dockerFoldersEvents: { entity: string; action: string; timestamp: number } },
        ];
        expect(topic).toBe(DOCKER_FOLDERS_EVENT_TOPIC);
        expect(payload.dockerFoldersEvents.entity).toBe('container');
        expect(payload.dockerFoldersEvents.action).toBe('start');
        expect(typeof payload.dockerFoldersEvents.timestamp).toBe('number');
    });

    it('does not let a rejected pubsub publish escape publish()', async () => {
        const nchan = fakeNchan();
        const pubsub = {
            publish: vi.fn().mockRejectedValue(new Error('subscriber gone')),
        } as unknown as PubSubEngine;
        const bus = new EventBusService(nchan, pubsub);

        // publish() is synchronous and fire-and-forget; a caller that awaited
        // nothing must not see this rejection either.
        expect(() => bus.publish('folder', 'deleted')).not.toThrow();
        await vi.waitFor(() => expect(pubsub.publish).toHaveBeenCalled());
    });

    it('still publishes to nchan with a null pubsub, the CLI case, and does not throw', () => {
        const nchan = fakeNchan();
        const bus = new EventBusService(nchan, null);

        expect(() => bus.publish('schedule', 'ran')).not.toThrow();

        expect(nchan.publish).toHaveBeenCalledWith('schedule', 'ran');
    });
});
