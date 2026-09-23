import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import type { DockerFoldersPullEvent } from '../pull-events.js';
import { UpdatesResolver } from '../updates.resolver.js';
import type { UpdatesService } from '../updates.service.js';

/** Drains an AsyncIterableIterator into a plain array. */
async function drain<T>(iterator: AsyncIterableIterator<T>): Promise<T[]> {
    const values: T[] = [];
    for await (const value of iterator) {
        values.push(value);
    }
    return values;
}

function fakePullEvents(image: string): Observable<DockerFoldersPullEvent> {
    return new Observable((subscriber) => {
        subscriber.next({ type: 'status', message: `Pulling ${image}...` });
        subscriber.next({ type: 'complete', message: 'Pull complete', image });
        subscriber.next({ type: 'done', finished: true });
        subscriber.complete();
    });
}

function fakeUpdatesService(overrides: Partial<Record<keyof UpdatesService, unknown>> = {}) {
    const base = {
        getCached: vi.fn(() => []),
        checkForUpdates: vi.fn(async () => []),
        pullImage: vi.fn(async () => ({ success: true, image: 'plex', error: null })),
        pullImageEvents: vi.fn((image: string) => fakePullEvents(image)),
        ...overrides,
    };
    return base as unknown as UpdatesService;
}

describe('UpdatesResolver.dockerFoldersImagePullEvents', () => {
    it('wraps every event as { dockerFoldersImagePullEvents: {event, data} }, matching pull.php\'s event names and fields', async () => {
        const updates = fakeUpdatesService();
        const resolver = new UpdatesResolver(updates);

        const values = await drain(resolver.dockerFoldersImagePullEvents('plex'));

        expect(values).toEqual([
            {
                dockerFoldersImagePullEvents: {
                    event: 'status',
                    data: JSON.stringify({ message: 'Pulling plex...' }),
                },
            },
            {
                dockerFoldersImagePullEvents: {
                    event: 'complete',
                    data: JSON.stringify({ message: 'Pull complete', image: 'plex' }),
                },
            },
            {
                dockerFoldersImagePullEvents: {
                    event: 'done',
                    data: JSON.stringify({ finished: true }),
                },
            },
        ]);
    });

    it('forwards containerIds/recreate to pullImageEvents exactly like the mutation does', async () => {
        const updates = fakeUpdatesService();
        const resolver = new UpdatesResolver(updates);

        await drain(resolver.dockerFoldersImagePullEvents('plex', ['abc123'], true));

        expect(updates.pullImageEvents).toHaveBeenCalledWith('plex', { containers: ['abc123'], recreate: true });
    });

    it('rejects synchronously-thrown validation errors (bad image name) as a subscribe failure, not a stream event', async () => {
        const updates = fakeUpdatesService({
            pullImageEvents: vi.fn(() => {
                throw new BadRequestException('Invalid image name');
            }),
        });
        const resolver = new UpdatesResolver(updates);

        expect(() => resolver.dockerFoldersImagePullEvents('../not-an-image')).toThrow(BadRequestException);
    });
});
