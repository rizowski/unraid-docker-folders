import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { build, type AdoptBuildResult } from './adopt-builder.js';
import { DOCKER_CLIENT_TOKEN, type DockerFoldersExtraDockerClient, type DockerFoldersRawImageInspect } from './extras-docker-client.js';

/**
 * Orchestrates the three lookups `AdoptBuilder::build` needs, ported from the
 * `adopt-fields` branch of `containers.php:90-117`: the container's own
 * inspect, its image's inspect (best effort — a missing image degrades the
 * result rather than failing it), and its network's driver.
 *
 * `AdoptBuilder.build()` itself stays pure and untouched by any of this; this
 * class is only the I/O PHP's `containers.php` does around the equivalent
 * PHP call.
 */
export interface DockerFoldersAdoptFieldsResult extends AdoptBuildResult {
    /** `Config.Labels['net.unraid.docker.managed']`, added by `containers.php:114`, not by `AdoptBuilder` itself. */
    managed: string | null;
}

@Injectable()
export class AdoptService {
    private readonly logger = new Logger(AdoptService.name);

    constructor(@Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerFoldersExtraDockerClient) {}

    async getAdoptFields(id: string): Promise<DockerFoldersAdoptFieldsResult> {
        if (id === '') {
            throw new BadRequestException('Container ID is required');
        }

        const inspect = await this.inspectOrNotFound(id);

        // The image is what makes the environment diff possible. Losing it is
        // not fatal, but every baked-in image variable then looks user-set,
        // so the caller is told (`imageEnvKnown: false`) rather than quietly
        // handed a noisy result.
        let image: DockerFoldersRawImageInspect = {};
        const imageId = inspect.Image ?? '';
        if (imageId !== '') {
            try {
                image = await this.docker.getImage(imageId).inspect();
            } catch (error) {
                this.logger.warn(`Could not inspect image ${imageId} for adopt fields: ${String(error)}`);
            }
        }

        // The driver decides whether Unraid publishes ports or turns them
        // into TCP_PORT_n variables, so the preview cannot describe ports
        // without it.
        const driver = await this.networkDriver(String(inspect.HostConfig?.NetworkMode ?? ''));

        const result = build(inspect, image, driver);
        const managed = inspect.Config?.Labels?.['net.unraid.docker.managed'] ?? null;

        return { ...result, managed };
    }

    private async inspectOrNotFound(id: string) {
        try {
            return await this.docker.getContainer(id).inspect();
        } catch (error) {
            const statusCode = (error as { statusCode?: number } | null)?.statusCode;
            if (statusCode === 404) {
                throw new NotFoundException('Container not found');
            }
            throw error;
        }
    }

    /**
     * `DockerClient::getNetworkDriver`: `''` for an unset network mode or one
     * that shares another container's namespace (`container:<id>`, which has
     * no network of its own to inspect), otherwise Docker's own driver name,
     * or `''` again if the network cannot be found.
     */
    private async networkDriver(name: string): Promise<string> {
        if (name === '' || name.startsWith('container:')) return '';

        try {
            const network = await this.docker.getNetwork(name).inspect();
            return network.Driver ?? '';
        } catch (error) {
            this.logger.warn(`Could not inspect network ${name}: ${String(error)}`);
            return '';
        }
    }
}
