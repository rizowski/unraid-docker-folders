import { describe, expect, it, vi } from 'vitest';

import type { ContainerService } from '../../containers/container.service.js';
import type { UpdatesService } from '../../updates/updates.service.js';
import { DockerFoldersScheduleExecutors, type ExecutorDockerClient, type StackActionRunner } from '../schedule-executors.js';

/**
 * `DockerFoldersScheduleExecutors`, ported from `ScheduleManager`'s
 * `executeContainerAction`, `executeContainerUpdate` and `executeStackAction`.
 * Focused on the `update` action's wiring: delegation for a container target,
 * and the fixed refusal for a stack target — the container/stack start/stop/
 * pause/resume/restart/backup paths are exercised end to end through
 * `ScheduleService` in `schedule.service.spec.ts` instead.
 */

function fakeDocker(containers: { Id: string; Names?: string[]; State?: string }[] = []): ExecutorDockerClient {
    return {
        listContainers: vi.fn(async () => containers),
        getContainer: vi.fn(() => ({ pause: () => Promise.reject(new Error('not used here')) })),
    };
}

function fakeUpdates(): { service: UpdatesService; updateContainer: ReturnType<typeof vi.fn> } {
    const updateContainer = vi.fn(async (name: string) => ({ success: true, message: `${name} updated` }));
    return { service: { updateContainer } as unknown as UpdatesService, updateContainer };
}

function fakeStacks(): StackActionRunner {
    return {
        stackUp: vi.fn(async () => ({ success: true })),
        stackStop: vi.fn(async () => ({ success: true })),
        stackRestart: vi.fn(async () => ({ success: true })),
    };
}

function fakeContainers(): ContainerService {
    return {
        start: vi.fn(async () => true),
        resume: vi.fn(async () => true),
        stop: vi.fn(async () => true),
        restart: vi.fn(async () => true),
    } as unknown as ContainerService;
}

describe('DockerFoldersScheduleExecutors', () => {
    describe('containerAction("update")', () => {
        it('delegates to UpdatesService.updateContainer, and returns its result verbatim', async () => {
            const docker = fakeDocker([{ Id: 'abc123', Names: ['/plex'], State: 'running' }]);
            const updates = fakeUpdates();
            const executors = new DockerFoldersScheduleExecutors(
                fakeContainers(),
                { backupContainer: vi.fn(), backupStack: vi.fn() } as never,
                docker,
                fakeStacks(),
                updates.service
            );

            const result = await executors.containerAction('plex', 'update');

            expect(result).toEqual({ success: true, message: 'plex updated' });
            expect(updates.updateContainer).toHaveBeenCalledWith('plex');
        });

        it('never lists containers itself — updateContainer does its own lookup by the tag it was created from', async () => {
            const docker = fakeDocker([{ Id: 'abc123', Names: ['/plex'], State: 'running' }]);
            const updates = fakeUpdates();
            const executors = new DockerFoldersScheduleExecutors(
                fakeContainers(),
                { backupContainer: vi.fn(), backupStack: vi.fn() } as never,
                docker,
                fakeStacks(),
                updates.service
            );

            await executors.containerAction('plex', 'update');

            expect(docker.listContainers).not.toHaveBeenCalled();
        });

        it("propagates a failure from updateContainer, e.g. 'not found'", async () => {
            const docker = fakeDocker([]);
            const updates = {
                service: {
                    updateContainer: vi.fn(async (name: string) => ({
                        success: false,
                        message: `Container '${name}' not found`,
                    })),
                } as unknown as UpdatesService,
            };
            const executors = new DockerFoldersScheduleExecutors(
                fakeContainers(),
                { backupContainer: vi.fn(), backupStack: vi.fn() } as never,
                docker,
                fakeStacks(),
                updates.service
            );

            const result = await executors.containerAction('ghost', 'update');

            expect(result).toEqual({ success: false, message: "Container 'ghost' not found" });
        });
    });

    describe('stackAction("update")', () => {
        it('refuses with the fixed message, like pause and resume, and never calls the stack runner', async () => {
            const stacks = fakeStacks();
            const updates = fakeUpdates();
            const executors = new DockerFoldersScheduleExecutors(
                fakeContainers(),
                { backupContainer: vi.fn(), backupStack: vi.fn() } as never,
                fakeDocker(),
                stacks,
                updates.service
            );

            const result = await executors.stackAction('media', 'update');

            expect(result).toEqual({ success: false, message: 'Update is not supported for compose stacks' });
            expect(stacks.stackUp).not.toHaveBeenCalled();
            expect(stacks.stackStop).not.toHaveBeenCalled();
            expect(stacks.stackRestart).not.toHaveBeenCalled();
            expect(updates.updateContainer).not.toHaveBeenCalled();
        });
    });
});
