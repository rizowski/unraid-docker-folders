import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AdoptService } from '../adopt.service.js';
import type {
    DockerFoldersExtraContainerHandle,
    DockerFoldersExtraDockerClient,
    DockerFoldersRawImageInspect,
    DockerFoldersRawInspect,
} from '../extras-docker-client.js';

function fakeDocker(overrides: {
    inspect?: () => Promise<DockerFoldersRawInspect>;
    imageInspect?: () => Promise<DockerFoldersRawImageInspect>;
    networkInspect?: (name: string) => Promise<{ Driver?: string }>;
}): DockerFoldersExtraDockerClient {
    return {
        getContainer: () => ({
            inspect: () => (overrides.inspect ? overrides.inspect() : Promise.resolve({})),
            // `logs()` is never called by AdoptService; the cast is only to
            // satisfy its two-overload type (`DockerFoldersLogsOptions` vs.
            // `DockerFoldersFollowLogsOptions`) with one implementation the
            // test never invokes.
            logs: (() =>
                Promise.reject(new Error('not used here'))) as unknown as DockerFoldersExtraContainerHandle['logs'],
            stats: () => Promise.reject(new Error('not used here')),
        }),
        getImage: () => ({
            inspect: () => (overrides.imageInspect ? overrides.imageInspect() : Promise.resolve({})),
        }),
        getNetwork: (name: string) => ({
            inspect: () => (overrides.networkInspect ? overrides.networkInspect(name) : Promise.resolve({})),
        }),
    };
}

describe('AdoptService', () => {
    it('rejects an empty id before making any Docker call', async () => {
        const service = new AdoptService(fakeDocker({}));

        await expect(service.getAdoptFields('')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('translates a 404 inspect into NotFoundException', async () => {
        const error = Object.assign(new Error('no such container'), { statusCode: 404 });
        const service = new AdoptService(
            fakeDocker({
                inspect: () => Promise.reject(error),
            })
        );

        await expect(service.getAdoptFields('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assembles fields and adds the managed label containers.php stamps on afterward', async () => {
        const service = new AdoptService(
            fakeDocker({
                inspect: async () => ({
                    Name: '/Adopt2',
                    Image: 'sha256:deadbeef',
                    Config: { Image: 'nginx:alpine', Labels: { 'net.unraid.docker.managed': 'dockerman' } },
                    HostConfig: { NetworkMode: 'bridge' },
                }),
                imageInspect: async () => ({ Config: {} }),
                networkInspect: async () => ({ Driver: 'bridge' }),
            })
        );

        const result = await service.getAdoptFields('abc');

        expect(result.managed).toBe('dockerman');
        expect(result.networkDriver).toBe('bridge');
        expect(result.fields.contName).toBe('Adopt2');
    });

    it('degrades gracefully when the image cannot be inspected', async () => {
        const service = new AdoptService(
            fakeDocker({
                inspect: async () => ({ Name: '/x', Image: 'sha256:aaa', Config: {}, HostConfig: {} }),
                imageInspect: () => Promise.reject(new Error('gone')),
            })
        );

        const result = await service.getAdoptFields('abc');
        expect(result.imageEnvKnown).toBe(false);
    });

    it('never inspects a network for an empty or container: network mode', async () => {
        let called = false;
        const service = new AdoptService(
            fakeDocker({
                inspect: async () => ({ Name: '/x', HostConfig: { NetworkMode: 'container:other' } }),
                networkInspect: async () => {
                    called = true;
                    return {};
                },
            })
        );

        const result = await service.getAdoptFields('abc');

        expect(called).toBe(false);
        expect(result.networkDriver).toBe('');
    });
});
