import { Inject, Injectable, Logger } from '@nestjs/common';
import type Dockerode from 'dockerode';

import { DOCKER_CLIENT_TOKEN, type DockerLifecycleClient } from '../containers/docker-client.js';
import { errorMessage, resolveImageTag, stripLeadingSlash } from './docker-refs.js';

/** `DockerClient::recreateContainer`'s stop timeout — 30s, not the 10s ordinary stop/restart use. */
const RECREATE_STOP_TIMEOUT_SECONDS = 30;

export interface RecreateResult {
    success: boolean;
    newId: string | null;
    error: string | null;
}

/** Docker answers "already in that state" with 304; see `ContainerService.isNotModified`. */
function isNotModified(error: unknown): boolean {
    return (error as { statusCode?: number } | null)?.statusCode === 304;
}

type RawConfig = Record<string, unknown>;

/**
 * Rebuild a `POST /containers/create` body from a running container's own
 * inspect data, ported from the config-building half of
 * `DockerClient::recreateContainer` (lines building `$config`/`$createBody`).
 *
 * PHP does a second pass over `ExposedPorts`/`Volumes`/`PortBindings` to turn
 * `[]` back into `{}`, because `json_decode(..., true)` cannot tell an empty
 * JSON object from an empty JSON array and collapses both to a PHP empty
 * array. That problem is PHP-specific: `inspect()` here hands back a real JS
 * object, where `{}` and `[]` are already distinct, so there is nothing to
 * repair and that whole pass is intentionally not ported.
 */
function buildCreateBody(inspect: Dockerode.ContainerInspectInfo, containerName: string): RawConfig {
    const { Hostname: _hostname, ...configRest } = (inspect.Config ?? {}) as RawConfig;
    const image = resolveImageTag(String(configRest.Image ?? ''), containerName);
    const config: RawConfig = { ...configRest, Image: image };

    const { ContainerIDFile: _containerIdFile, ...hostConfigRest } = (inspect.HostConfig ?? {}) as RawConfig;
    const createBody: RawConfig = { ...config, HostConfig: hostConfigRest };

    const networks = inspect.NetworkSettings?.Networks ?? {};
    const networkNames = Object.keys(networks);
    if (networkNames.length > 0) {
        const endpointsConfig: Record<string, unknown> = {};
        for (const [netName, netConfig] of Object.entries(networks)) {
            const raw = netConfig as RawConfig;
            endpointsConfig[netName] = {
                IPAMConfig: raw.IPAMConfig ?? null,
                Aliases: raw.Aliases ?? null,
                Links: raw.Links ?? null,
                DriverOpts: raw.DriverOpts ?? null,
            };
        }
        createBody.NetworkingConfig = { EndpointsConfig: endpointsConfig };
    }

    return createBody;
}

/**
 * Recreate a container with its current configuration but the latest image,
 * ported from `DockerClient::recreateContainer`: inspect → stop → rename →
 * create → start → remove old, with a rollback at every step that can fail.
 *
 * This is the riskiest thing in this port — a rollback that itself fails
 * leaves a user's container gone — so every step's failure path is tested
 * individually (see `__tests__/recreate.service.spec.ts`), and each rollback
 * call is itself best-effort: it cannot throw past this method, because a
 * thrown rollback would abandon whatever cleanup was left.
 *
 * Injects `DOCKER_CLIENT_TOKEN` typed as `DockerLifecycleClient`, not the
 * base `DockerClient` — see that interface's doc comment in `docker-client.ts`
 * for why the three extra methods live on a sub-interface instead.
 */
@Injectable()
export class RecreateService {
    private readonly logger = new Logger(RecreateService.name);

    constructor(@Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerLifecycleClient) {}

    async recreateContainer(id: string): Promise<RecreateResult> {
        let inspect: Dockerode.ContainerInspectInfo;
        try {
            inspect = await this.docker.inspectContainerRaw(id);
        } catch {
            // PHP reports this exact generic message regardless of the actual
            // inspect failure reason (network error vs. a genuine 404).
            return { success: false, newId: null, error: `Container ${id} not found` };
        }

        const containerName = stripLeadingSlash(inspect.Name ?? '');
        const wasRunning = inspect.State?.Running === true;
        const oldId = inspect.Id;
        // Same scheme as PHP: `{name}-recreating-{unix seconds}`.
        const tempName = `${containerName}-recreating-${Math.floor(Date.now() / 1000)}`;
        const createBody = buildCreateBody(inspect, containerName);

        let newId: string | null = null;

        try {
            if (wasRunning) {
                try {
                    await this.docker.getContainer(oldId).stop({ t: RECREATE_STOP_TIMEOUT_SECONDS });
                } catch (error) {
                    if (!isNotModified(error)) {
                        return {
                            success: false,
                            newId: null,
                            error: `Failed to stop container ${containerName}: ${errorMessage(error)}`,
                        };
                    }
                }
            }

            try {
                await this.docker.renameContainer(oldId, tempName);
            } catch (error) {
                if (wasRunning) await this.tryStart(oldId, containerName);
                return {
                    success: false,
                    newId: null,
                    error: `Failed to rename container ${containerName}: ${errorMessage(error)}`,
                };
            }

            try {
                newId = await this.docker.createContainer(containerName, createBody);
            } catch (error) {
                await this.tryRename(oldId, containerName);
                if (wasRunning) await this.tryStart(oldId, containerName);
                return {
                    success: false,
                    newId: null,
                    error: `Failed to create new container ${containerName}: ${errorMessage(error)}`,
                };
            }

            if (wasRunning) {
                try {
                    await this.docker.getContainer(newId).start();
                } catch (error) {
                    await this.tryRemove(newId, containerName);
                    await this.tryRename(oldId, containerName);
                    await this.tryStart(oldId, containerName);
                    return {
                        success: false,
                        newId: null,
                        error: `Failed to start new container ${containerName}: ${errorMessage(error)}`,
                    };
                }
            }

            await this.tryRemove(oldId, containerName);

            return { success: true, newId, error: null };
        } catch (error) {
            // Emergency rollback for anything unexpected slipping past the
            // specific handlers above (mirrors PHP's outer catch(\Throwable)).
            if (newId !== null) await this.tryRemove(newId, containerName);
            await this.tryRename(oldId, containerName);
            if (wasRunning) await this.tryStart(oldId, containerName);
            return { success: false, newId: null, error: errorMessage(error) };
        }
    }

    /** Best-effort restart during a rollback. Never throws. */
    private async tryStart(id: string, containerName: string): Promise<void> {
        try {
            await this.docker.getContainer(id).start();
        } catch (error) {
            this.logger.warn(`Rollback: could not restart ${containerName} (${id}): ${errorMessage(error)}`);
        }
    }

    /** Best-effort rename during a rollback. Never throws. */
    private async tryRename(id: string, newName: string): Promise<void> {
        try {
            await this.docker.renameContainer(id, newName);
        } catch (error) {
            this.logger.warn(`Rollback: could not rename ${id} back to ${newName}: ${errorMessage(error)}`);
        }
    }

    /** Best-effort forced removal during a rollback. Never throws. */
    private async tryRemove(id: string, containerName: string): Promise<void> {
        try {
            await this.docker.getContainer(id).remove({ force: true });
        } catch (error) {
            this.logger.warn(`Rollback: could not remove ${containerName} (${id}): ${errorMessage(error)}`);
        }
    }
}
