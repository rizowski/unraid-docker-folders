/**
 * The slice of dockerode this plugin uses.
 *
 * Declared as an interface rather than imported as a type so the tests can
 * hand the service a fake without a Docker socket. Dockerode satisfies it
 * structurally, so the real client is passed straight through.
 *
 * `dockerode` is already a dependency of the Unraid API itself (4.0.7 on
 * 4.35.1), so the plugin peer-depends on it and resolves the copy the API
 * installed. Nothing extra is shipped.
 */

import Dockerode from 'dockerode';

import type { BrowserDockerClient } from '../paths/path-browser.service.js';
import type { ExecutorDockerClient } from '../schedules/schedule-executors.js';
import type { DockerFoldersExtraDockerClient } from './extras-docker-client.js';

/** What `inspect` answers with, narrowed to the fields this plugin reads. */
export interface DockerInspectInfo {
    Name?: string;
    Image?: string;
    State?: { Paused?: boolean };
    HostConfig?: { PortBindings?: unknown; Privileged?: unknown; CapAdd?: unknown } | null;
    Config?: { ExposedPorts?: unknown; User?: unknown; Env?: unknown } | null;
}

export interface DockerContainerHandle {
    inspect(): Promise<DockerInspectInfo>;
    start(): Promise<unknown>;
    stop(options: { t: number }): Promise<unknown>;
    restart(options: { t: number }): Promise<unknown>;
    unpause(): Promise<unknown>;
    remove(options: { force: boolean }): Promise<unknown>;
}

export interface DockerImageHandle {
    remove(options: { force: boolean }): Promise<unknown>;
    /**
     * `RepoDigests` and `Config.Labels` are additive over the container-list
     * use of this same handle (which only reads `Config.User`): image update
     * checking needs the local digest (`DockerClient::getImageDigest`) and the
     * `org.opencontainers.image.source` label (`DockerClient::checkImageUpdate`).
     */
    inspect(): Promise<{
        Config?: { User?: unknown; Labels?: Record<string, string> | null } | null;
        RepoDigests?: string[];
    }>;
}

/** `GET /distribution/{name}/json`'s answer, narrowed to the field used. */
export interface DockerDistributionInfo {
    Descriptor?: { digest?: string } | null;
}

/**
 * The handful of fields `docker-modem`'s `dial()` callback needs, typed by
 * hand because `@types/dockerode` declares `Dockerode#modem` as `any`.
 */
interface DockerModem {
    dial(
        options: {
            path: string;
            method: string;
            statusCodes: Record<number, true | string>;
            abortSignal?: AbortSignal;
        },
        callback: (error: (Error & { statusCode?: number }) | null, data?: unknown) => void
    ): void;
}

/**
 * One entry of `GET /containers/json`.
 *
 * Deliberately not Dockerode's `ContainerInfo`. That type declares several of
 * these as required when Docker omits them in practice, and the mapper has to
 * cope with a missing field rather than trust a type that is wrong about the
 * wire.
 */
export interface DockerListContainer {
    Id: string;
    Names?: string[];
    Image?: string;
    ImageID?: string;
    Command?: string;
    Created?: number;
    State?: string;
    Status?: string;
    Ports?: { IP?: string; PrivatePort?: number; PublicPort?: number; Type?: string }[];
    Labels?: Record<string, string> | null;
    HostConfig?: { NetworkMode?: string } | null;
    Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[];
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null } | null;
}

/**
 * Docker's own event stream, filtered on Docker's side.
 *
 * `filters` is the wire shape: a map of field name to accepted values, which
 * dockerode JSON-encodes into the query string. The stream is
 * newline-delimited JSON, not objects, so the caller parses it.
 */
export interface DockerEventsOptions {
    filters?: Record<string, string[]>;
}

export interface DockerClient {
    listContainers(options: { all: boolean }): Promise<DockerListContainer[]>;
    getContainer(id: string): DockerContainerHandle;
    getImage(id: string): DockerImageHandle;
    getEvents(options: DockerEventsOptions): Promise<NodeJS.ReadableStream>;
    /**
     * The remote registry digest, via the daemon's own `/distribution`
     * endpoint (so it uses whatever registry credentials the daemon has,
     * exactly like `DockerClient::getRemoteImageDigest`). Not part of
     * dockerode's high-level API, hence the hand-rolled `dial()` call in
     * `createDockerClient()` below.
     */
    distributionInspect(imageRef: string): Promise<DockerDistributionInfo>;
    /**
     * The raw newline-delimited-JSON progress stream from `images/create`,
     * exactly as `DockerClient::pullImage` reads it over a raw curl handle.
     * The caller (`UpdatesService`) parses it; this layer only fetches it.
     */
    pullImage(imageRef: string): Promise<NodeJS.ReadableStream>;
}

/** Same socket `DockerClient.php` talks to, and the same one the API uses. */
export const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

export const DOCKER_CLIENT_TOKEN = 'DOCKER_FOLDERS_DOCKER_CLIENT';

/** `DockerClient::getRemoteImageDigest`'s curl timeout, matched here. */
const DISTRIBUTION_TIMEOUT_MS = 15_000;

/**
 * `GET /distribution/{name}/json` has no dockerode wrapper, so this dials it
 * directly through docker-modem, the same transport dockerode's own methods
 * are built on.
 *
 * The image reference is concatenated into the path raw, not
 * `encodeURIComponent`-ed: it legitimately contains `/` (a namespace) and `:`
 * (a tag), and encoding either would ask the daemon for a literal `%2F` or
 * `%3A` it will not resolve. `DockerClient.php` builds the same URL the same
 * way for the same reason.
 */
function distributionInspect(dockerode: Dockerode, imageRef: string): Promise<DockerDistributionInfo> {
    return new Promise((resolve, reject) => {
        (dockerode.modem as DockerModem).dial(
            {
                path: `/distribution/${imageRef}/json`,
                method: 'GET',
                statusCodes: { 200: true, 404: 'no such image', 500: 'server error' },
                abortSignal: AbortSignal.timeout(DISTRIBUTION_TIMEOUT_MS),
            },
            (error, data) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve((data ?? {}) as DockerDistributionInfo);
            }
        );
    });
}

/**
 * `RecreateService`'s three extra calls, ported from
 * `DockerClient::recreateContainer` (inspect, rename, create — stop/start/
 * remove already exist on `DockerContainerHandle`).
 *
 * A sub-interface of `DockerClient`, not three more members on it directly.
 * `src/containers/__tests__/container.service.spec.ts` builds a
 * `const client: DockerClient = {...}` literal, and that file is owned by
 * another agent's concurrent work right now — widening `DockerClient` itself
 * would make that literal stop satisfying the interface with no way for this
 * change to fix it. `RecreateService` is the only consumer, so it injects
 * `DOCKER_CLIENT_TOKEN` typed as `DockerLifecycleClient` instead. Once the
 * other agent's work lands, these three members can move onto `DockerClient`
 * itself and this interface can go away.
 */
export interface DockerLifecycleClient extends DockerClient {
    /**
     * Full, unnarrowed `GET /containers/{id}/json`. `DockerContainerHandle`'s
     * own `inspect()` only types the fields the container list and container
     * actions read; recreate needs the whole `Config`/`HostConfig`/
     * `NetworkSettings` payload to rebuild a create body from it.
     */
    inspectContainerRaw(id: string): Promise<Dockerode.ContainerInspectInfo>;
    /** `POST /containers/{id}/rename?name=...` — `DockerClient::renameContainer`. */
    renameContainer(id: string, newName: string): Promise<void>;
    /** `POST /containers/create?name=...` — `DockerClient::createContainer`. Resolves to the new container's id. */
    createContainer(name: string, config: Record<string, unknown>): Promise<string>;
}

/**
 * Every shape a service injects `DOCKER_CLIENT_TOKEN` as.
 *
 * Nest binds the token by string, so nothing at runtime checks that the
 * wrapper below has what each service calls. Typing the factory's result as
 * all of them together makes the compiler check it instead. `getNetwork`
 * was missing once, and every adopt request quietly lost its network driver.
 */
export type EveryDockerClientShape = DockerLifecycleClient &
    DockerFoldersExtraDockerClient &
    BrowserDockerClient &
    ExecutorDockerClient;

export function createDockerClient(): EveryDockerClientShape {
    const dockerode = new Dockerode({ socketPath: DOCKER_SOCKET_PATH });

    // Per-property, not a single `new Dockerode(...)` cast: `distributionInspect`,
    // `pullImage` (as a Promise<ReadableStream>, not dockerode's callback form),
    // and the three DockerLifecycleClient members have no native dockerode
    // equivalent, so this object is a thin wrapper rather than the client
    // itself. The other four are still dockerode's own methods, passed
    // straight through, so this is the only place that checks their
    // signatures still match.
    const client: EveryDockerClientShape = {
        listContainers: (options) => dockerode.listContainers(options),
        getContainer: (id) => dockerode.getContainer(id),
        getImage: (id) => dockerode.getImage(id),
        getNetwork: (name) => dockerode.getNetwork(name),
        getEvents: (options) => dockerode.getEvents(options),
        distributionInspect: (imageRef) => distributionInspect(dockerode, imageRef),
        pullImage: (imageRef) => dockerode.pull(imageRef),
        inspectContainerRaw: (id) => dockerode.getContainer(id).inspect(),
        renameContainer: async (id, newName) => {
            await dockerode.getContainer(id).rename({ name: newName });
        },
        createContainer: async (name, config) => {
            const container = await dockerode.createContainer({
                ...(config as Dockerode.ContainerCreateOptions),
                name,
            });
            return container.id;
        },
    };
    return client;
}
