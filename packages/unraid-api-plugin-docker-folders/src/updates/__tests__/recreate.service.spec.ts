import type Dockerode from 'dockerode';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DockerLifecycleClient } from '../../containers/docker-client.js';
import { RecreateService } from '../recreate.service.js';

const OLD_ID = 'old-id';
const NEW_ID = 'new-id';
const NAME = 'myapp';

/**
 * A stand-in for `DockerLifecycleClient`, tracking every call so a rollback
 * sequence can be asserted call-by-call. Failures are keyed by container id
 * (`OLD_ID`/`NEW_ID`), since a rollback re-issues the same verb — rename,
 * start — against the *other* container than the one that just failed, and a
 * fake that could not tell them apart would not catch a rollback hitting the
 * wrong one.
 */
function fakeLifecycleClient(inspect: Partial<Dockerode.ContainerInspectInfo>) {
    const calls: string[] = [];
    const failStopFor = new Set<string>();
    const failStartFor = new Set<string>();
    const failRenameFor = new Set<string>();
    const failRemoveFor = new Set<string>();
    let failInspect: Error | null = null;
    let failCreate: Error | null = null;

    const handle = (id: string) => ({
        inspect: (): Promise<never> => Promise.reject(new Error('not used here')),
        start: async () => {
            calls.push(`start ${id}`);
            if (failStartFor.has(id)) throw new Error(`start failed for ${id}`);
        },
        stop: async (options: { t: number }) => {
            calls.push(`stop ${id} t=${options.t}`);
            if (failStopFor.has(id)) throw new Error(`stop failed for ${id}`);
        },
        restart: (): Promise<never> => Promise.reject(new Error('not used here')),
        unpause: (): Promise<never> => Promise.reject(new Error('not used here')),
        remove: async (options: { force: boolean }) => {
            calls.push(`remove ${id} force=${options.force}`);
            if (failRemoveFor.has(id)) throw new Error(`remove failed for ${id}`);
        },
    });

    const client: DockerLifecycleClient = {
        listContainers: () => Promise.reject(new Error('not used here')),
        getContainer: (id: string) => handle(id),
        getImage: () => {
            throw new Error('not used here');
        },
        getEvents: () => Promise.reject(new Error('not used here')),
        distributionInspect: () => Promise.reject(new Error('not used here')),
        pullImage: () => Promise.reject(new Error('not used here')),
        inspectContainerRaw: async (id: string) => {
            calls.push(`inspect ${id}`);
            if (failInspect) throw failInspect;
            return inspect as Dockerode.ContainerInspectInfo;
        },
        renameContainer: async (id: string, newName: string) => {
            calls.push(`rename ${id}->${newName}`);
            if (failRenameFor.has(id)) throw new Error(`rename failed for ${id}`);
        },
        createContainer: async (name: string) => {
            calls.push(`create ${name}`);
            if (failCreate) throw failCreate;
            return NEW_ID;
        },
    };

    return {
        client,
        calls,
        failInspect: (error: Error) => {
            failInspect = error;
        },
        failStop: (id: string) => failStopFor.add(id),
        failStart: (id: string) => failStartFor.add(id),
        failRename: (id: string) => failRenameFor.add(id),
        failRemove: (id: string) => failRemoveFor.add(id),
        failCreate: (error: Error) => {
            failCreate = error;
        },
    };
}

function runningInspect(): Dockerode.ContainerInspectInfo {
    return {
        Id: OLD_ID,
        Name: `/${NAME}`,
        State: { Running: true } as Dockerode.ContainerInspectInfo['State'],
        Config: { Hostname: 'old-hostname', Image: 'linuxserver/plex:latest', Labels: {} } as Dockerode.ContainerInspectInfo['Config'],
        HostConfig: { ContainerIDFile: '/some/path', NetworkMode: 'bridge' } as Dockerode.ContainerInspectInfo['HostConfig'],
        NetworkSettings: { Networks: {} } as Dockerode.ContainerInspectInfo['NetworkSettings'],
    } as Dockerode.ContainerInspectInfo;
}

function stoppedInspect(): Dockerode.ContainerInspectInfo {
    return { ...runningInspect(), State: { Running: false } as Dockerode.ContainerInspectInfo['State'] };
}

describe('RecreateService', () => {
    let docker: ReturnType<typeof fakeLifecycleClient>;
    let service: RecreateService;

    function build(inspect: Dockerode.ContainerInspectInfo) {
        docker = fakeLifecycleClient(inspect);
        service = new RecreateService(docker.client);
    }

    beforeEach(() => {
        build(runningInspect());
    });

    it('cannot even be inspected: reports a generic not-found and touches nothing else', async () => {
        docker.failInspect(new Error('ECONNREFUSED'));

        const result = await service.recreateContainer(OLD_ID);

        expect(result).toEqual({ success: false, newId: null, error: `Container ${OLD_ID} not found` });
        expect(docker.calls).toEqual([`inspect ${OLD_ID}`]);
    });

    it('stop fails: no rename, no create — the original container is untouched', async () => {
        docker.failStop(OLD_ID);

        const result = await service.recreateContainer(OLD_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(new RegExp(`^Failed to stop container ${NAME}:`));
        expect(docker.calls).toEqual([`inspect ${OLD_ID}`, `stop ${OLD_ID} t=30`]);
    });

    it('a stopped container is never stopped or restarted', async () => {
        build(stoppedInspect());

        const result = await service.recreateContainer(OLD_ID);

        expect(result.success).toBe(true);
        expect(docker.calls).toEqual([
            `inspect ${OLD_ID}`,
            expect.stringMatching(new RegExp(`^rename ${OLD_ID}->${NAME}-recreating-\\d+$`)),
            `create ${NAME}`,
            `remove ${OLD_ID} force=true`,
        ]);
        expect(docker.calls.some((c) => c.startsWith(`stop ${OLD_ID}`))).toBe(false);
        expect(docker.calls.some((c) => c.startsWith(`start ${NEW_ID}`))).toBe(false);
    });

    it('rename fails: rolls back by restarting the original — no create is attempted', async () => {
        docker.failRename(OLD_ID);

        const result = await service.recreateContainer(OLD_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(new RegExp(`^Failed to rename container ${NAME}:`));
        expect(docker.calls).toEqual([
            `inspect ${OLD_ID}`,
            `stop ${OLD_ID} t=30`,
            expect.stringMatching(new RegExp(`^rename ${OLD_ID}->${NAME}-recreating-\\d+$`)),
            `start ${OLD_ID}`,
        ]);
        expect(docker.calls.some((c) => c.startsWith('create'))).toBe(false);
    });

    it('create fails: renames the original back and restarts it', async () => {
        docker.failCreate(new Error('no such image'));

        const result = await service.recreateContainer(OLD_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(new RegExp(`^Failed to create new container ${NAME}: no such image$`));
        expect(docker.calls).toEqual([
            `inspect ${OLD_ID}`,
            `stop ${OLD_ID} t=30`,
            expect.stringMatching(new RegExp(`^rename ${OLD_ID}->${NAME}-recreating-\\d+$`)),
            `create ${NAME}`,
            `rename ${OLD_ID}->${NAME}`,
            `start ${OLD_ID}`,
        ]);
        expect(docker.calls.some((c) => c.startsWith('remove'))).toBe(false);
    });

    it('start fails: removes the new container, renames the original back, and restarts it', async () => {
        docker.failStart(NEW_ID);

        const result = await service.recreateContainer(OLD_ID);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(new RegExp(`^Failed to start new container ${NAME}: start failed for ${NEW_ID}$`));
        expect(docker.calls).toEqual([
            `inspect ${OLD_ID}`,
            `stop ${OLD_ID} t=30`,
            expect.stringMatching(new RegExp(`^rename ${OLD_ID}->${NAME}-recreating-\\d+$`)),
            `create ${NAME}`,
            `start ${NEW_ID}`,
            `remove ${NEW_ID} force=true`,
            `rename ${OLD_ID}->${NAME}`,
            `start ${OLD_ID}`,
        ]);
    });

    it('succeeds: stops, renames, creates, starts the new one, and removes the old one', async () => {
        const result = await service.recreateContainer(OLD_ID);

        expect(result).toEqual({ success: true, newId: NEW_ID, error: null });
        expect(docker.calls).toEqual([
            `inspect ${OLD_ID}`,
            `stop ${OLD_ID} t=30`,
            expect.stringMatching(new RegExp(`^rename ${OLD_ID}->${NAME}-recreating-\\d+$`)),
            `create ${NAME}`,
            `start ${NEW_ID}`,
            `remove ${OLD_ID} force=true`,
        ]);
    });

    it('a rollback that itself fails to restart the original is logged, not thrown', async () => {
        docker.failCreate(new Error('no such image'));
        docker.failStart(OLD_ID); // the rollback's own restart of the original

        const result = await service.recreateContainer(OLD_ID);

        // The reported error is still the original failure, not the rollback's.
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Failed to create new container/);
        expect(docker.calls).toContain(`start ${OLD_ID}`);
    });

    it('builds the create body without Hostname, without HostConfig.ContainerIDFile, and with a four-key EndpointsConfig entry per network', async () => {
        build({
            Id: OLD_ID,
            Name: `/${NAME}`,
            State: { Running: false },
            Config: {
                Hostname: 'should-be-dropped',
                Image: 'linuxserver/plex:latest',
                Labels: {},
            },
            HostConfig: {
                ContainerIDFile: '/should/be/dropped',
                NetworkMode: 'bridge',
            },
            NetworkSettings: {
                Networks: {
                    bridge: {
                        NetworkID: 'net1',
                        EndpointID: 'ep1',
                        Gateway: '172.17.0.1',
                        IPAddress: '172.17.0.5',
                        IPAMConfig: { IPv4Address: '172.17.0.5' },
                        Aliases: ['myapp'],
                    },
                },
            },
        } as unknown as Dockerode.ContainerInspectInfo);

        let capturedConfig: Record<string, unknown> | undefined;
        docker.client.createContainer = async (name: string, config: Record<string, unknown>) => {
            capturedConfig = config;
            return NEW_ID;
        };

        await service.recreateContainer(OLD_ID);

        expect(capturedConfig).toBeDefined();
        expect(capturedConfig?.Hostname).toBeUndefined();
        expect((capturedConfig?.HostConfig as Record<string, unknown>).ContainerIDFile).toBeUndefined();
        expect((capturedConfig?.HostConfig as Record<string, unknown>).NetworkMode).toBe('bridge');

        const endpoints = (capturedConfig?.NetworkingConfig as { EndpointsConfig: Record<string, unknown> })
            .EndpointsConfig.bridge as Record<string, unknown>;
        expect(Object.keys(endpoints).sort()).toEqual(['Aliases', 'DriverOpts', 'IPAMConfig', 'Links']);
    });
});
