import { NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { FolderService } from '../../folders/folder.service.js';
import { ContainerService } from '../container.service.js';
import type { DockerClient, DockerInspectInfo } from '../docker-client.js';

/**
 * A stand-in for dockerode that records what was asked of it.
 *
 * The real client needs a Docker socket, which no test box has. The service
 * takes the narrow interface in `docker-client.ts` precisely so this can be
 * handed to it unchanged.
 */
function fakeDocker(inspect: DockerInspectInfo = {}) {
    const calls: string[] = [];
    const fail: Record<string, Error> = {};
    const container = {
        inspect: async () => {
            calls.push('inspect');
            if (fail.inspect) throw fail.inspect;
            return inspect;
        },
        start: async () => {
            calls.push('start');
            if (fail.start) throw fail.start;
        },
        unpause: async () => {
            calls.push('unpause');
            if (fail.unpause) throw fail.unpause;
        },
        stop: async (options: { t: number }) => {
            calls.push(`stop t=${options.t}`);
            if (fail.stop) throw fail.stop;
        },
        restart: async (options: { t: number }) => {
            calls.push(`restart t=${options.t}`);
            if (fail.restart) throw fail.restart;
        },
        remove: async (options: { force: boolean }) => {
            calls.push(`remove force=${options.force}`);
            if (fail.remove) throw fail.remove;
        },
    };
    const image = {
        remove: async (options: { force: boolean }) => {
            calls.push(`removeImage force=${options.force}`);
            if (fail.removeImage) throw fail.removeImage;
        },
        // Only the list path reads an image's user; the actions never do.
        inspect: () => Promise.reject(new Error('not used here')),
    };
    const client: DockerClient = {
        getContainer: () => container,
        getImage: (id: string) => {
            calls.push(`getImage ${id}`);
            return image;
        },
        listContainers: () => Promise.reject(new Error('not used here')),
        // Container actions never touch the event stream; DockerEventService
        // owns it. Present only because the interface is one client.
        getEvents: () => Promise.reject(new Error('not used here')),
        // Nor image updates; UpdatesService owns those two.
        distributionInspect: () => Promise.reject(new Error('not used here')),
        pullImage: () => Promise.reject(new Error('not used here')),
    };
    return { client, calls, fail };
}

describe('ContainerService', () => {
    let temp: TempDatabase;
    let folders: FolderService;
    let publish: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        temp = createMigratedDatabase();
        publish = vi.fn();
        folders = new FolderService(new DatabaseService(temp.path), {
            publish,
        } as unknown as EventBusService);
    });

    afterEach(() => {
        temp.cleanup();
    });

    function build(inspect?: DockerInspectInfo) {
        const docker = fakeDocker(inspect);
        const service = new ContainerService(docker.client, folders, {
            publish,
        } as unknown as EventBusService);
        return { service, docker };
    }

    describe('start', () => {
        it('starts a container that is not paused', async () => {
            const { service, docker } = build({ State: { Paused: false } });

            await expect(service.start('abc')).resolves.toBe(true);

            expect(docker.calls).toEqual(['inspect', 'start']);
        });

        it('resumes a paused container instead, the way PHP does', async () => {
            const { service, docker } = build({ State: { Paused: true } });

            await service.start('abc');

            // Docker answers a start on a paused container with 304 and leaves
            // it paused, so starting it would silently do nothing.
            expect(docker.calls).toEqual(['inspect', 'unpause']);
        });
    });

    describe('stop and restart', () => {
        it('gives Docker the same ten seconds PHP gives it', async () => {
            const { service, docker } = build();

            await service.stop('abc');
            await service.restart('abc');

            expect(docker.calls).toEqual(['stop t=10', 'restart t=10']);
        });
    });

    describe('resume', () => {
        it('unpauses without inspecting first', async () => {
            const { service, docker } = build();

            await service.resume('abc');

            expect(docker.calls).toEqual(['unpause']);
        });
    });

    describe('remove', () => {
        it('does not force, so a running container is refused not killed', async () => {
            const { service, docker } = build({ Name: '/plex' });

            await service.remove('abc');

            expect(docker.calls).toContain('remove force=false');
        });

        it('forgets the folder membership and the saved order', async () => {
            const folder = folders.createFolder({ name: 'Media' });
            folders.addContainerToFolder(folder.id, 'abc', 'plex');
            folders.setUnfolderedOrder(['plex', 'nginx']);
            const { service } = build({ Name: '/plex' });

            await service.remove('abc');

            expect(folders.getFolder(folder.id)?.containers).toEqual([]);
            expect(folders.getUnfolderedOrder()).toEqual(['nginx']);
            // No exclusion row: there is no Compose sync left to fight.
            expect(temp.rows('SELECT * FROM compose_sync_exclusions')).toEqual([]);
        });

        it('leaves the image alone unless asked', async () => {
            const { service, docker } = build({ Name: '/plex', Image: 'sha256:cafe' });

            await service.remove('abc');

            expect(docker.calls.some((call) => call.startsWith('removeImage'))).toBe(false);
        });

        it('removes the image the container was inspected for, forced', async () => {
            const { service, docker } = build({ Name: '/plex', Image: 'sha256:cafe' });

            await service.remove('abc', true);

            expect(docker.calls).toContain('getImage sha256:cafe');
            expect(docker.calls).toContain('removeImage force=true');
        });

        it('still reports success when the image will not go', async () => {
            const { service, docker } = build({ Name: '/plex', Image: 'sha256:cafe' });
            docker.fail.removeImage = new Error('image is in use');

            // The container is gone by then, so failing here would report a
            // removal that happened as one that did not.
            await expect(service.remove('abc', true)).resolves.toBe(true);
        });

        it('keeps the folder membership when Docker refused the removal', async () => {
            const folder = folders.createFolder({ name: 'Media' });
            folders.addContainerToFolder(folder.id, 'abc', 'plex');
            const { service, docker } = build({ Name: '/plex' });
            docker.fail.remove = new Error('container is running');

            await expect(service.remove('abc')).rejects.toThrow(/container is running/);

            expect(folders.getFolder(folder.id)?.containers).toHaveLength(1);
        });
    });

    describe('Docker 304', () => {
        it('counts an already-stopped stop as success, the way PHP does', async () => {
            const { service, docker } = build();
            docker.fail.stop = Object.assign(
                new Error('(HTTP code 304) container already stopped -  '),
                { statusCode: 304 }
            );

            // DockerClient.php returns true on a 304 outright. A schedule fires
            // a stop without checking state first, so raising here would turn a
            // no-op into a failed scheduled action.
            await expect(service.stop('abc')).resolves.toBe(true);
            expect(publish).toHaveBeenCalledWith('container', 'stop');
        });

        it('counts an already-running start as success too', async () => {
            const { service, docker } = build({ State: { Paused: false } });
            docker.fail.start = Object.assign(new Error('already started'), { statusCode: 304 });

            await expect(service.start('abc')).resolves.toBe(true);
        });
    });

    describe('failures', () => {
        it('reports a container Docker does not know as not found', async () => {
            const { service, docker } = build();
            docker.fail.stop = Object.assign(new Error('no such container'), { statusCode: 404 });

            await expect(service.stop('abc')).rejects.toThrow(NotFoundException);
        });

        it('keeps the reason Docker gave for anything else', async () => {
            const { service, docker } = build();
            docker.fail.stop = new Error('conflict: container is paused');

            await expect(service.stop('abc')).rejects.toThrow(/conflict: container is paused/);
        });

        it('stays quiet when the action failed', async () => {
            const { service, docker } = build();
            docker.fail.start = new Error('nope');

            await expect(service.start('abc')).rejects.toThrow();

            expect(publish).not.toHaveBeenCalled();
        });
    });

    describe('announcements', () => {
        it('names an action for every button, so no open tab is left stale', async () => {
            const { service } = build({ Name: '/plex', State: { Paused: false } });

            await service.start('abc');
            await service.resume('abc');
            await service.stop('abc');
            await service.restart('abc');
            await service.remove('abc');

            const containerEvents = publish.mock.calls.filter((call) => call[0] === 'container');
            expect(containerEvents.map((call) => call[1])).toEqual([
                'start',
                'resume',
                'stop',
                'restart',
                'remove',
            ]);
        });

        it('tells folder listeners too, because a removal changes a folder', async () => {
            const folder = folders.createFolder({ name: 'Media' });
            folders.addContainerToFolder(folder.id, 'abc', 'plex');
            publish.mockClear();
            const { service } = build({ Name: '/plex' });

            await service.remove('abc');

            expect(publish).toHaveBeenCalledWith('folder', 'forget_container');
        });
    });
});
