import type {
    DockerFoldersRawConfig,
    DockerFoldersRawHostConfig,
    DockerFoldersRawImageInspect,
    DockerFoldersRawInspect,
} from './extras-docker-client.js';

/**
 * Turns a `docker inspect` result into the POST body that Unraid's own
 * `/Docker/UpdateContainer` endpoint accepts. Ported from `AdoptBuilder.php`,
 * function for function, method for method.
 *
 * Unraid then writes the dockerMan template and recreates the container with
 * the `net.unraid.docker.*` labels, so this plugin never writes into
 * `templates-user/` and never calls `docker rm`. The field contract lives in
 * Unraid's `Helpers.php::postToXML`. Two details from there are load-bearing,
 * carried over unchanged:
 *
 *  - Most `cont*` scalars are read WITHOUT a null-coalesce there, so every key
 *    has to be present in the result even when its value is empty.
 *  - The nine `conf*` arrays are parallel. Entry N of each describes one
 *    mapping — `configs` below is that same list, one object per mapping,
 *    with all nine (well, ten — `Value` duplicates `Default`) attributes on
 *    each so nothing can drift out of alignment the way parallel arrays can.
 *
 * Pure transform: no database, no Docker socket, no filesystem, exactly like
 * the PHP class this ports. Exhaustively tested against a line-for-line
 * translation of `AdoptBuilderTest.php` in `__tests__/adopt-builder.spec.ts`.
 */

/** Docker's own default shared-memory size, reported even when `--shm-size` was never passed. */
const DEFAULT_SHM_SIZE = 67108864;

/** Docker's default runtime. Anything else was asked for explicitly. */
const DEFAULT_RUNTIME = 'runc';

/**
 * Variables Unraid injects itself in `xmlToCommand` (Helpers.php:426-430).
 * Carrying them through would re-add them on every adopt and, worse, pin a
 * stale hostname into the template.
 *
 * `TZ` is deliberately NOT in this list. Unraid adds its own, but a user who
 * set a different one meant it, and the later `-e` wins.
 */
const UNRAID_INJECTED_VARS = ['HOST_OS', 'HOST_HOSTNAME', 'HOST_CONTAINERNAME'];

/** Variable names whose values are hidden in Unraid's form. */
const SECRET_NAME_PATTERN = /PASS|SECRET|TOKEN|KEY|CREDENTIAL/i;

/**
 * Network drivers on which Unraid does NOT publish ports.
 *
 * `xmlToCommand` switches on the driver (Helpers.php:524). For these it turns
 * every Port config into a `TCP_PORT_<n>` / `UDP_PORT_<n>` environment
 * variable instead of emitting `-p`, because the container gets its own
 * address. Verified on a real box: a container moved to br0 (ipvlan)
 * produced `-e TCP_PORT_80=18081` and no `-p` at all.
 */
const UNPUBLISHED_PORT_DRIVERS = ['host', 'macvlan', 'ipvlan', 'null'];

export interface AdoptConfigEntry {
    Name: string;
    Target: string;
    Default: string;
    Mode: string;
    Description: string;
    Type: string;
    Display: string;
    Required: string;
    Mask: string;
    Value: string;
}

export interface AdoptBuildResult {
    fields: Record<string, string>;
    configs: AdoptConfigEntry[];
    unmapped: string[];
    imageEnvKnown: boolean;
    networkDriver: string;
    portsPublished: boolean;
}

/**
 * PHP's `escapeshellarg` on Linux: wrap in single quotes, and neutralise an
 * embedded quote by closing the quoting, emitting an escaped literal quote,
 * then reopening it (`'` -> `'\''`).
 *
 * This never reaches a shell in this plugin — the result is a POST field
 * value Unraid's PHP later splices into a `docker create` command line on its
 * own server, not something this code executes. It is ported here only
 * because `AdoptBuilder`'s output must byte-match what the PHP would have
 * sent, including this exact quoting, for Unraid's side to behave the same
 * way.
 */
function escapeshellarg(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/** PHP's `(int)` cast: numbers pass through, numeric strings parse, everything else is 0. */
function toInt(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
    const parsed = parseInt(String(value ?? ''), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** PHP's `===` on two arrays: same length, same values, same order. */
function arraysEqual(a: unknown[] | null, b: unknown[] | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
}

/**
 * PHP's `!==` on `Entrypoint`, which — unlike `Cmd` — Docker's own inspect
 * type documents as either a bare string or a string array (a live inspect
 * always returns an array in practice, but the type is carried through
 * faithfully; see the comment on `DockerFoldersRawConfig.Entrypoint`). PHP's
 * strict inequality is type-sensitive: a string is never `===` an array
 * holding the same text. Comparing serialised JSON reproduces that — mismatched
 * types serialise to different strings, and two arrays only match when every
 * element and the order are identical — without a bespoke comparator per shape.
 */
function sameEntrypoint(a: string | string[] | null, b: string | string[] | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** PHP's `(array)$entrypoint` cast: a bare string becomes its own one-element array. */
function toEntrypointArray(value: string | string[]): string[] {
    return Array.isArray(value) ? value : [value];
}

/**
 * Whether Unraid will emit `-p` for this container's ports.
 *
 * On host, macvlan and ipvlan networks it emits `TCP_PORT_n` variables
 * instead, and joining another container's namespace leaves no ports of its
 * own. The preview needs this so it does not promise a published port that
 * will not be.
 */
function publishesPorts(network: string, driver: string): boolean {
    if (network.startsWith('container:')) return false;
    if (network === 'none') return false;
    if (driver === '') return true;
    return !UNPUBLISHED_PORT_DRIVERS.includes(driver);
}

/** One `<Config>` entry with all ten attributes Unraid expects. */
function entry(name: string, target: string, value: string, type: string, mode = '', mask = false): AdoptConfigEntry {
    return {
        Name: name,
        Target: target,
        Default: value,
        Mode: mode,
        Description: '',
        Type: type,
        Display: 'always',
        Required: 'false',
        Mask: mask ? 'true' : 'false',
        Value: value,
    };
}

/**
 * Published ports, from `HostConfig.PortBindings`.
 *
 * Keys look like `"80/tcp"`. `Target` is the container port, the value is the
 * host port, `Mode` is the protocol — see `xmlToCommand`, which emits
 * `-p host:container/proto`.
 */
function buildPorts(host: DockerFoldersRawHostConfig, unmapped: string[]): AdoptConfigEntry[] {
    const out: AdoptConfigEntry[] = [];
    const bindings = host.PortBindings;
    if (bindings === null || bindings === undefined || typeof bindings !== 'object') return out;

    for (const [spec, binds] of Object.entries(bindings)) {
        if (!Array.isArray(binds) || binds.length === 0) continue;

        const slash = spec.indexOf('/');
        const containerPort = slash === -1 ? spec : spec.slice(0, slash);
        const proto = slash === -1 ? 'tcp' : spec.slice(slash + 1);

        const first = binds[0] ?? {};
        const hostPort = String(first.HostPort ?? '');
        if (hostPort === '') continue;

        // The template's Port type cannot express a bind address, and it
        // cannot express a second binding for the same container port. Say so
        // rather than dropping either silently.
        const hostIp = String(first.HostIp ?? '');
        if (hostIp !== '' && hostIp !== '0.0.0.0' && hostIp !== '::') {
            unmapped.push(`port ${spec} is bound to ${hostIp} only; it will be published on all addresses`);
        }
        if (binds.length > 1) {
            unmapped.push(`port ${spec} has ${binds.length} host bindings; only ${hostPort} is kept`);
        }

        out.push(entry(`Port ${containerPort}`, containerPort, hostPort, 'Port', proto));
    }
    return out;
}

/**
 * Bind mounts only, from `Mounts`.
 *
 * `Mounts` is used rather than `HostConfig.Binds` because it is already split
 * into source, destination and mode.
 *
 * Named volumes are deliberately NOT emitted as Path configs. `xmlToCommand`
 * mkdirs the host side of every Path that does not exist (Helpers.php:130-133),
 * and a volume's "host side" is a bare name. Verified on a real box: adopting
 * a container with `-v adopt2-data:/data` created an empty `adopt2-data`
 * directory relative to the PHP process's working directory. They go through
 * `buildVolumeArgs` into `ExtraParams` instead, which is spliced verbatim and
 * never triggers a mkdir.
 */
function buildPaths(inspect: DockerFoldersRawInspect): AdoptConfigEntry[] {
    const out: AdoptConfigEntry[] = [];
    for (const mount of inspect.Mounts ?? []) {
        if ((mount.Type ?? 'bind') !== 'bind') continue;

        const destination = mount.Destination ?? '';
        const source = mount.Source ?? '';
        if (destination === '' || source === '') continue;

        const mode = Object.hasOwn(mount, 'RW') && !mount.RW ? 'ro' : 'rw';
        out.push(entry(destination, destination, source, 'Path', mode));
    }
    return out;
}

/**
 * Named volumes, as raw `-v` flags for `ExtraParams`.
 *
 * See `buildPaths` for why these cannot be Path configs. Both sides are
 * escaped because `ExtraParams` is spliced into the command line without
 * quoting.
 */
function buildVolumeArgs(inspect: DockerFoldersRawInspect): string[] {
    const out: string[] = [];
    for (const mount of inspect.Mounts ?? []) {
        if ((mount.Type ?? '') !== 'volume') continue;

        const destination = mount.Destination ?? '';
        const name = mount.Name ?? '';
        if (destination === '' || name === '') continue;

        const mode = Object.hasOwn(mount, 'RW') && !mount.RW ? 'ro' : 'rw';
        out.push(`-v ${escapeshellarg(name)}:${escapeshellarg(destination)}:${mode}`);
    }
    return out;
}

/**
 * Turn `["NAME=value", ...]` into a `Map` of name to value, preserving order.
 *
 * Splits on the first `=` only: values legitimately contain `=` (base64,
 * connection strings), and splitting on all of them corrupts them.
 */
function envMap(env: string[] | null | undefined): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of env ?? []) {
        const text = String(line);
        const pos = text.indexOf('=');
        if (pos === -1) {
            out.set(text, '');
            continue;
        }
        out.set(text.slice(0, pos), text.slice(pos + 1));
    }
    return out;
}

/**
 * User-set environment variables.
 *
 * `Config.Env` merges the image's baked-in `ENV` with the user's `-e` flags,
 * so it has to be diffed against the image. Without this every adopted
 * container gains a wall of variables it never asked for, and they then
 * become part of the saved template forever.
 *
 * A variable counts as user-set when the image does not define it at all, or
 * defines it with a different value.
 */
function buildVariables(config: DockerFoldersRawConfig, imageConfig: DockerFoldersRawConfig): AdoptConfigEntry[] {
    const imageEnv = envMap(imageConfig.Env);
    const out: AdoptConfigEntry[] = [];

    for (const [name, value] of envMap(config.Env)) {
        if (UNRAID_INJECTED_VARS.includes(name)) continue;
        if (imageEnv.has(name) && imageEnv.get(name) === value) continue;

        const mask = SECRET_NAME_PATTERN.test(name);
        out.push(entry(name, name, value, 'Variable', '', mask));
    }
    return out;
}

/**
 * User-set labels.
 *
 * Image labels are dropped for the same reason image env is. The unraid
 * labels are dropped because Unraid stamps them itself, and compose labels
 * are dropped because a compose container should not be adopted at all — the
 * UI gates on that separately.
 */
function buildLabels(config: DockerFoldersRawConfig, imageConfig: DockerFoldersRawConfig): AdoptConfigEntry[] {
    const imageLabels = imageConfig.Labels ?? {};
    const out: AdoptConfigEntry[] = [];

    for (const [key, rawValue] of Object.entries(config.Labels ?? {})) {
        const value = String(rawValue);
        if (key.startsWith('net.unraid.')) continue;
        if (key.startsWith('com.docker.compose.')) continue;
        if (Object.hasOwn(imageLabels, key) && String(imageLabels[key]) === value) continue;

        out.push(entry(key, key, value, 'Label'));
    }
    return out;
}

/**
 * Device passthrough.
 *
 * `xmlToCommand` emits `--device=<Value>` and ignores `Target` for this type
 * (Helpers.php:154-156), so the host path is the value that matters.
 */
function buildDevices(host: DockerFoldersRawHostConfig): AdoptConfigEntry[] {
    const out: AdoptConfigEntry[] = [];
    for (const device of host.Devices ?? []) {
        const hostPath = device.PathOnHost ?? '';
        if (hostPath === '') continue;
        const inContainer = device.PathInContainer ?? hostPath;
        out.push(entry(hostPath, inContainer, hostPath, 'Device'));
    }
    return out;
}

/**
 * Flags with no template field, rendered back into `ExtraParams`.
 *
 * Unraid splices `ExtraParams` verbatim into the `docker create` line just
 * before the image name (Helpers.php `xmlToCommand`), so anything valid on a
 * command line survives. This was confirmed on a real container:
 * `--restart=unless-stopped` round-tripped untouched.
 */
function extraParams(host: DockerFoldersRawHostConfig, inspect: DockerFoldersRawInspect, unmapped: string[]): string {
    // Named volumes ride here rather than in a Path config — see buildPaths.
    const params = buildVolumeArgs(inspect);

    const restart = host.RestartPolicy?.Name ?? '';
    if (restart !== '' && restart !== 'no') {
        const retries = toInt(host.RestartPolicy?.MaximumRetryCount ?? 0);
        const value = restart === 'on-failure' && retries > 0 ? `on-failure:${retries}` : restart;
        params.push(`--restart=${escapeshellarg(value)}`);
    }

    for (const cap of host.CapAdd ?? []) {
        params.push(`--cap-add=${escapeshellarg(String(cap))}`);
    }
    for (const cap of host.CapDrop ?? []) {
        params.push(`--cap-drop=${escapeshellarg(String(cap))}`);
    }
    for (const opt of host.SecurityOpt ?? []) {
        params.push(`--security-opt ${escapeshellarg(String(opt))}`);
    }
    for (const hostEntry of host.ExtraHosts ?? []) {
        params.push(`--add-host=${escapeshellarg(String(hostEntry))}`);
    }
    for (const [key, value] of Object.entries(host.Sysctls ?? {})) {
        params.push(`--sysctl ${escapeshellarg(`${key}=${value}`)}`);
    }
    for (const ulimit of host.Ulimits ?? []) {
        const name = ulimit.Name ?? '';
        if (name === '') continue;
        const soft = toInt(ulimit.Soft ?? 0);
        const hard = toInt(ulimit.Hard ?? soft);
        params.push(`--ulimit ${escapeshellarg(`${name}=${soft}:${hard}`)}`);
    }

    // Cast to int, so not attacker-shaped.
    const shm = toInt(host.ShmSize ?? 0);
    if (shm > 0 && shm !== DEFAULT_SHM_SIZE) {
        params.push(`--shm-size=${shm}`);
    }

    const runtime = host.Runtime ?? '';
    if (runtime !== '' && runtime !== DEFAULT_RUNTIME) {
        params.push(`--runtime=${escapeshellarg(runtime)}`);
    }

    // Recognised, non-default, and genuinely not expressible. Reported so the
    // preview can warn rather than letting the container come back subtly
    // different.
    if (host.GroupAdd && host.GroupAdd.length > 0) {
        unmapped.push(`--group-add (${host.GroupAdd.join(', ')})`);
    }
    if (host.Tmpfs && Object.keys(host.Tmpfs).length > 0) {
        unmapped.push(`--tmpfs (${Object.keys(host.Tmpfs).join(', ')})`);
    }
    if (host.DeviceRequests && host.DeviceRequests.length > 0) {
        unmapped.push('--gpus / --device-requests');
    }

    return params.join(' ');
}

/**
 * A command override, which Unraid appends after the image name.
 *
 * Only a `Cmd` that differs from the image's own default was actually typed
 * by the user. An `Entrypoint` override has no template field at all, so it
 * is reported instead of guessed at.
 */
function postArgs(
    config: DockerFoldersRawConfig,
    imageConfig: DockerFoldersRawConfig,
    hasImageConfig: boolean,
    unmapped: string[]
): string {
    const entrypoint = config.Entrypoint ?? null;
    const imageEntrypoint = imageConfig.Entrypoint ?? null;
    if (hasImageConfig && entrypoint !== null && !sameEntrypoint(entrypoint, imageEntrypoint)) {
        unmapped.push(`--entrypoint (${toEntrypointArray(entrypoint).join(' ')})`);
    }

    const cmd = config.Cmd ?? null;
    if (cmd === null || !Array.isArray(cmd)) return '';
    if (hasImageConfig && arraysEqual(imageConfig.Cmd ?? null, cmd)) return '';
    // With no image to compare against, assume the Cmd is the image's own.
    // Repeating it is harmless, but inventing one is not.
    if (!hasImageConfig) return '';

    // Each element escaped separately. Unraid splices PostArgs into the
    // docker command line raw and runs the result through a shell, so a Cmd
    // element like `daemon off; worker_processes 2;` — which nginx images
    // really do carry — would otherwise end the docker invocation at the
    // semicolon and run the rest as its own shell command. Escaping per
    // element also preserves the original argv boundaries instead of
    // re-splitting on spaces.
    return cmd.map((part) => escapeshellarg(String(part))).join(' ');
}

/** The fixed IP on a custom network, if the user pinned one. */
function fixedIp(inspect: DockerFoldersRawInspect, network: string): string {
    const networks = inspect.NetworkSettings?.Networks ?? {};
    const ipam = networks[network]?.IPAMConfig;
    if (ipam === null || ipam === undefined || typeof ipam !== 'object') return '';
    return ipam.IPv4Address ?? '';
}

/**
 * Build the POST field set for one container.
 *
 * @param inspect One element of `docker inspect <container>`.
 * @param image One element of `docker inspect <image>`, or `{}` if the image
 *   could not be read. Without it every baked-in image variable looks
 *   user-set, so the caller should treat `{}` as degraded rather than normal.
 * @param networkDriver Driver of the container's network, from `docker
 *   network inspect`. Only used to work out whether Unraid will publish
 *   ports; `''` assumes it will.
 */
export function build(
    inspect: DockerFoldersRawInspect,
    image: DockerFoldersRawImageInspect = {},
    networkDriver = ''
): AdoptBuildResult {
    const config = inspect.Config ?? {};
    const host = inspect.HostConfig ?? {};
    const imageConfig = image.Config ?? {};
    // PHP's `!empty($imageConfig)`: an empty array (no keys at all) is false.
    const imageEnvKnown = Object.keys(imageConfig).length > 0;

    const unmapped: string[] = [];
    const configs: AdoptConfigEntry[] = [];

    const network = host.NetworkMode ?? 'bridge';

    configs.push(...buildPorts(host, unmapped));
    configs.push(...buildPaths(inspect));
    configs.push(...buildVariables(config, imageConfig));
    configs.push(...buildLabels(config, imageConfig));
    configs.push(...buildDevices(host));

    const fields: Record<string, string> = {
        // Derived from the container.
        contName: (inspect.Name ?? '').replace(/^\//, ''),
        // KNOWN PHP BUG, carried over deliberately (AdoptBuilder.php:103, not
        // fixed here): this reads `Config.Image`, the raw reference the
        // container was created with, rather than the tag resolved through
        // `resolveImageTag`/`imageFromTemplate`. After an image update moves
        // the tag to a new digest, `Config.Image` on the OLD container is
        // still whatever string was used at `docker create` time (often
        // already a tag, so this is usually right by luck), but if the
        // container was originally created FROM a bare digest, adopting it
        // repeats that digest into `contRepository` instead of a human tag.
        // The PHP team is tracking this; this port matches it rather than
        // silently fixing it, so both backends produce the same (wrong, in
        // that one case) POST body.
        contRepository: config.Image ?? '',
        contNetwork: network,
        contMyIP: fixedIp(inspect, network),
        contPrivileged: host.Privileged ? 'on' : '',
        contCPUset: host.CpusetCpus ?? '',
        contPostArgs: postArgs(config, imageConfig, imageEnvKnown, unmapped),
        contExtraParams: extraParams(host, inspect, unmapped),
        contShell: 'sh',

        // No Docker equivalent exists. Emitted empty on purpose — do not
        // invent values. WebUI and Icon in particular are what the user fills
        // in after the adopt, and leaving them blank is honest rather than
        // lossy.
        contRegistry: '',
        contMyMAC: '',
        contSupport: '',
        contProject: '',
        contReadMe: '',
        contOverview: '',
        contCategory: '',
        contWebUI: '',
        contTemplateURL: '',
        contIcon: '',
        contDonateText: '',
        contDonateLink: '',
        contRequires: '',

        // Not a cont* field, and not part of Tailscale's own block: postToXML
        // reads $post['TSstatedir'] unguarded at Helpers.php:198, outside the
        // `if contTailscale == on` branch. Omitting it makes Unraid emit a PHP
        // warning into its own response on every adopt.
        TSstatedir: '',
    };

    return {
        fields,
        configs,
        unmapped: [...new Set(unmapped)],
        imageEnvKnown,
        networkDriver,
        portsPublished: publishesPorts(network, networkDriver),
    };
}
