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

const asMap = (value: unknown): Record<string, unknown> => (isMap(value) ? value : {});
const isMap = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function omitKeys(map: Record<string, unknown>, remove: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(map).filter(([key]) => !(key in remove)));
}

/**
 * Same as PHP's loose `==` on these fields: null, a missing value, an empty
 * list and an empty string all mean "unset". Docker reports an unset
 * Entrypoint as null on one side and [] on the other.
 */
function sameJson(a: unknown, b: unknown): boolean {
    const unset = (value: unknown) => value == null || value === '' || (Array.isArray(value) && value.length === 0);
    if (unset(a) || unset(b)) return unset(a) && unset(b);
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reduce a container's inspect `Config` to what the user set, ported from
 * `DockerClient::userSettingsConfig`. Inspect Config merges the image's own
 * defaults with the user's overrides, so each field is kept only where it
 * differs from the OLD image's Config; the new image's defaults fill the rest.
 *
 * Known gap (same as PHP): a user value equal to the old image's default looks
 * like the default and is dropped.
 *
 * `imageConfig` null (the old image could not be inspected) keeps the whole
 * Config, apart from the Hostname rule.
 */
export function userSettingsConfig(
    config: RawConfig,
    imageConfig: RawConfig | null,
    oldId: string,
    networkMode = '',
): RawConfig {
    const out: RawConfig = { ...config };

    // A generated hostname (first 12 characters of the id) follows the new
    // container. A user-set one stays. Docker refuses a hostname with a shared
    // network namespace, and inspect shows the host's name for the host network.
    if (out.Hostname === oldId.slice(0, 12) || networkMode.startsWith('container:') || networkMode === 'host') {
        delete out.Hostname;
    }
    if (imageConfig === null) return out;

    if (Array.isArray(out.Env)) {
        const imageEnv = Array.isArray(imageConfig.Env) ? (imageConfig.Env as string[]) : [];
        out.Env = out.Env.filter((entry) => !imageEnv.includes(entry as string));
    }
    if (isMap(out.Labels)) {
        const imageLabels = asMap(imageConfig.Labels);
        out.Labels = Object.fromEntries(
            Object.entries(out.Labels).filter(([key, value]) => !(key in imageLabels && imageLabels[key] === value)),
        );
    }
    for (const field of ['ExposedPorts', 'Volumes']) {
        if (isMap(out[field])) {
            out[field] = omitKeys(out[field], asMap(imageConfig[field]));
        }
    }
    // Single values: copy only when they differ from the image's.
    for (const field of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'StopSignal', 'Healthcheck', 'Shell', 'OnBuild']) {
        if (field in out && sameJson(out[field], imageConfig[field])) delete out[field];
    }
    return out;
}

/**
 * `HostConfig.Mounts` for a recreate that keeps the old anonymous volumes,
 * ported from `DockerClient::reuseAnonymousVolumes`.
 *
 * An anonymous volume is a volume mount with a 64-hex name that no bind or
 * HostConfig.Mounts entry names. One at a path the OLD image declared with
 * VOLUME and the NEW image no longer declares is dropped (the old volume stays
 * on disk, unattached). A path the old image did not declare is the user's own
 * and is always kept; so is any declared mount. With either image Config
 * unknown (null), nothing is dropped.
 *
 * Known gap, kept on purpose (same as PHP): a user's own `-v /x` at a path the
 * old image also declared, which the new image no longer declares, is dropped
 * too. Inspect shows the same anonymous volume in both cases.
 */
export function reuseAnonymousVolumes(
    inspect: RawConfig,
    oldImageConfig: RawConfig | null = null,
    newImageConfig: RawConfig | null = null,
): RawConfig[] {
    const hostConfig = (inspect.HostConfig ?? {}) as RawConfig;
    const mounts = [...((hostConfig.Mounts as RawConfig[] | undefined) ?? [])].map((mount) => ({ ...mount }));
    const removedByImage =
        oldImageConfig !== null && newImageConfig !== null
            ? omitKeys(asMap(oldImageConfig.Volumes), asMap(newImageConfig.Volumes))
            : {};

    const named = new Set<string>();
    const targets = new Set<string>();
    for (const bind of (hostConfig.Binds as string[] | undefined) ?? []) {
        const [source, target] = bind.split(':');
        named.add(source);
        if (target !== undefined) targets.add(target);
    }
    for (const mount of mounts) {
        if (mount.Source) named.add(String(mount.Source));
        if (mount.Target) targets.add(String(mount.Target));
    }

    for (const mount of (inspect.Mounts as RawConfig[] | undefined) ?? []) {
        const name = String(mount.Name ?? '');
        const target = String(mount.Destination ?? '');
        if (mount.Type !== 'volume' || target === '' || !/^[0-9a-f]{64}$/.test(name) || named.has(name)) continue;
        // A declared mount with an empty Source: fill in the old volume.
        const declared = mounts.find((m) => m.Type === 'volume' && m.Target === target && !m.Source);
        if (declared) {
            declared.Source = name;
        } else if (!targets.has(target) && !(target in removedByImage)) {
            mounts.push({ Type: 'volume', Source: name, Target: target, ...(mount.RW === false ? { ReadOnly: true } : {}) });
        }
    }
    return mounts;
}

/**
 * Rebuild a `POST /containers/create` body from a running container's own
 * inspect data, ported from `DockerClient::buildRecreateBody`.
 *
 * PHP repairs `[]` back into `{}` for ExposedPorts/Volumes/PortBindings,
 * because `json_decode(..., true)` collapses both. That problem is
 * PHP-specific: `inspect()` here hands back real JS objects, so that pass is
 * intentionally not ported.
 *
 * `oldImageConfig` is the Config of the image the container runs now (by id),
 * `newImageConfig` the Config of the image it will be created from. Null means
 * unknown, which keeps more (see `userSettingsConfig`, `reuseAnonymousVolumes`).
 */
export function buildCreateBody(
    inspect: Dockerode.ContainerInspectInfo,
    containerName: string,
    oldImageConfig: RawConfig | null = null,
    newImageConfig: RawConfig | null = null,
): RawConfig {
    const hostConfig = (inspect.HostConfig ?? {}) as RawConfig;
    const config = userSettingsConfig(
        (inspect.Config ?? {}) as RawConfig,
        oldImageConfig,
        inspect.Id ?? '',
        String(hostConfig.NetworkMode ?? ''),
    );
    config.Image = resolveImageTag(String(config.Image ?? ''), containerName);

    const { ContainerIDFile: _containerIdFile, ...hostConfigRest } = hostConfig;

    // Keep anonymous volumes (and their data) across the recreate.
    const mounts = reuseAnonymousVolumes(inspect as unknown as RawConfig, oldImageConfig, newImageConfig);
    const createBody: RawConfig = {
        ...config,
        HostConfig: mounts.length > 0 ? { ...hostConfigRest, Mounts: mounts } : hostConfigRest,
    };

    // A container that joins another's network namespace cannot declare
    // ports, and Docker answers 400 "conflicting options: port exposing and
    // the container type network mode". Inspect still lists the image's
    // EXPOSE ports in Config.ExposedPorts, so drop them (issue #43).
    if (String(hostConfigRest.NetworkMode ?? '').startsWith('container:')) {
        delete createBody.ExposedPorts;
    }

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
                // Keep the MAC the container has on every network, set by the
                // user or generated by Docker: inspect cannot tell them apart,
                // and a router's DHCP reservation is keyed on it. Docker 25+
                // reports it on the endpoint only, and a create without it
                // assigns a new one. PHP does the same from API 1.44
                // (DockerClient::planNetworks with $keepMacs).
                ...(raw.MacAddress ? { MacAddress: raw.MacAddress } : {}),
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
        // The old image by id (its tag may already point at the new one after the
        // pull) and the new image by tag, right before the create. A failed
        // inspect gives null, which keeps more rather than dropping data.
        const [oldImageConfig, newImageConfig] = await Promise.all([
            this.imageConfig(String(inspect.Image ?? '')),
            this.imageConfig(resolveImageTag(String(inspect.Config?.Image ?? ''), containerName)),
        ]);
        if (oldImageConfig === null) {
            this.logger.warn(`recreate ${containerName}: old image inspect failed, copying the whole container config`);
        }
        const createBody = buildCreateBody(inspect, containerName, oldImageConfig, newImageConfig);

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

    /** `Config` of an image, or null when it cannot be inspected. */
    private async imageConfig(image: string): Promise<RawConfig | null> {
        try {
            const info = await this.docker.getImage(image).inspect();
            return isMap(info.Config) ? info.Config : null;
        } catch {
            return null;
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
