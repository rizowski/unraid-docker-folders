/**
 * The container facts that only `docker inspect` carries.
 *
 * Docker's list endpoint does not return `HostConfig` or `Config`, so none of
 * this is in the container list: the published port bindings, whether the
 * container is privileged, its added capabilities, its exposed ports, and who
 * it runs as. The security advisor is built entirely out of these, so a list
 * without them silently reports every container as clean.
 *
 * Ported from `DockerClient::extractFacts`, and kept a pure transform for the
 * same reason it is one there: it can be tested exhaustively without a Docker
 * socket, and the socket-shaped part of the work stays somewhere else.
 *
 * Every field here is immutable for a given container id. `docker update`
 * cannot change any of them, and editing one through Unraid's template
 * recreates the container with a new id. That is what makes caching them by id
 * safe.
 */

/** One published port binding, flattened out of Docker's nested shape. */
export interface HostPortBinding {
    hostIp: string;
    hostPort: number;
    containerPort: number;
    type: string;
}

export interface ContainerFacts {
    ports: HostPortBinding[];
    privileged: boolean;
    capAdd: string[];
    /** Docker's own `"8989/tcp"` form. The frontend splits it. */
    exposedPorts: string[];
    /**
     * `Config.User`. Empty on most containers, because most images declare no
     * USER. When an image does declare one, Docker copies it here, so a value
     * on its own does not mean anybody overrode it: the caller pairs this with
     * the image's own user, and only a difference between the two is an
     * override.
     */
    user: string;
    /**
     * The user the process actually ends up as on Unraid. Images from
     * linuxserver.io start as root and drop to these, so they decide who owns
     * the files a container writes into a share, which `user` above almost
     * never states.
     */
    puid: string;
    pgid: string;
    /**
     * Decides the mode of every file the container creates, so it decides
     * whether the user and group above actually keep anybody out. Empty means
     * the image never overrode the default.
     */
    umask: string;
}

/** The slice of an inspect payload this reads. Everything is optional. */
export interface InspectPayload {
    HostConfig?: {
        PortBindings?: unknown;
        Privileged?: unknown;
        CapAdd?: unknown;
    } | null;
    Config?: {
        ExposedPorts?: unknown;
        User?: unknown;
        Env?: unknown;
    } | null;
}

export function extractFacts(inspect: InspectPayload): ContainerFacts {
    const host = isRecord(inspect.HostConfig) ? inspect.HostConfig : {};
    const config = isRecord(inspect.Config) ? inspect.Config : {};

    const capAdd = (host as { CapAdd?: unknown }).CapAdd;
    const exposed = (config as { ExposedPorts?: unknown }).ExposedPorts;
    const env = (config as { Env?: unknown }).Env;

    return {
        ports: parsePortBindings((host as { PortBindings?: unknown }).PortBindings),
        privileged: Boolean((host as { Privileged?: unknown }).Privileged),
        capAdd: Array.isArray(capAdd) ? capAdd.map(String) : [],
        exposedPorts: isRecord(exposed) ? Object.keys(exposed).map(String) : [],
        user: asString((config as { User?: unknown }).User),
        puid: envValue(env, 'PUID'),
        pgid: envValue(env, 'PGID'),
        umask: envValue(env, 'UMASK'),
    };
}

/**
 * Read one variable out of Docker's `["NAME=value", ...]` environment list.
 *
 * Splits on the first `=` only, because a value legitimately contains more of
 * them. Answers the empty string when the variable is absent, which the
 * frontend reads as "this container does not say who it runs as".
 */
export function envValue(env: unknown, key: string): string {
    if (!Array.isArray(env)) return '';

    const prefix = `${key}=`;
    for (const line of env) {
        const text = String(line);
        if (text.startsWith(prefix)) return text.slice(prefix.length);
    }
    return '';
}

/**
 * Flatten Docker's `HostConfig.PortBindings` map into a list.
 *
 * Input shape: `"<containerPort>/<proto>"` to a list of `{HostIp, HostPort}`.
 *
 * A binding with an empty `HostPort` is skipped, and that is deliberate rather
 * than an oversight. It means a port published without a fixed host port, so
 * Docker picks a new one on every start. These facts are cached by container
 * id and never invalidated, precisely because everything else here is
 * immutable, so caching a randomly assigned port would serve a stale number
 * from then on. The live value is already in the list endpoint's own `ports`,
 * which is refetched every time.
 */
export function parsePortBindings(portBindings: unknown): HostPortBinding[] {
    if (!isRecord(portBindings)) return [];

    const out: HostPortBinding[] = [];
    for (const [portProto, bindings] of Object.entries(portBindings)) {
        if (!Array.isArray(bindings) || bindings.length === 0) continue;

        const [portPart, protoPart] = String(portProto).split('/');
        const containerPort = toInt(portPart);
        const type = protoPart ?? 'tcp';

        for (const binding of bindings) {
            if (!isRecord(binding)) continue;
            const hostPort = asString((binding as { HostPort?: unknown }).HostPort);
            if (hostPort === '') continue;

            out.push({
                hostIp: asString((binding as { HostIp?: unknown }).HostIp),
                hostPort: toInt(hostPort),
                containerPort,
                type,
            });
        }
    }

    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string {
    return value === undefined || value === null ? '' : String(value);
}

/** PHP's `(int)` cast: leading digits, or 0. Never NaN. */
function toInt(value: string | undefined): number {
    const parsed = parseInt(value ?? '', 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}
