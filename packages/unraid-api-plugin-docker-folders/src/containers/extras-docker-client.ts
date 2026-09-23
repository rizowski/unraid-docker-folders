/**
 * The slice of dockerode these four endpoints use that `docker-client.ts`
 * does not already declare: logs, one-shot stats, a raw (wide) inspect, image
 * inspect, and network inspect.
 *
 * Declared here rather than added to `docker-client.ts` because that file is
 * owned by another change in flight. Dockerode satisfies this interface
 * structurally, exactly as it satisfies the narrower one there, so the same
 * real client (and the same `DOCKER_CLIENT_TOKEN` provider in `index.ts`) can
 * be injected against either type. Only the token — a string — is imported
 * from `docker-client.ts`; no type from that file is reused, since its shapes
 * may change under this work.
 *
 * Every field below is read with a fallback (`?? ''`, `?? []`, ...) at the
 * call site, the same defensiveness `container-facts.ts` and
 * `unraid-templates.ts` use for the same reason: these are Docker's own wire
 * shapes, not ours, and a field Docker omits must not throw.
 */

/** One `HostConfig.PortBindings` entry, e.g. `{HostIp: '', HostPort: '18081'}`. */
export interface DockerFoldersRawPortBinding {
    HostIp?: string;
    HostPort?: string;
}

export interface DockerFoldersRawMount {
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
}

export interface DockerFoldersRawDevice {
    PathOnHost?: string;
    PathInContainer?: string;
}

export interface DockerFoldersRawUlimit {
    Name?: string;
    Soft?: number;
    Hard?: number;
}

export interface DockerFoldersRawHostConfig {
    NetworkMode?: string;
    Privileged?: boolean;
    CpusetCpus?: string;
    PortBindings?: Record<string, DockerFoldersRawPortBinding[] | null> | null;
    Devices?: DockerFoldersRawDevice[] | null;
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    ExtraHosts?: string[] | null;
    Sysctls?: Record<string, string> | null;
    Ulimits?: DockerFoldersRawUlimit[] | null;
    ShmSize?: number;
    Runtime?: string;
    GroupAdd?: string[] | null;
    Tmpfs?: Record<string, string> | null;
    DeviceRequests?: unknown[] | null;
}

export interface DockerFoldersRawConfig {
    Image?: string;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
    Cmd?: string[] | null;
    /**
     * `string | string[]`, not just `string[]`: `@types/dockerode`'s
     * `ContainerInspectInfo.Config.Entrypoint` types it as `string | string[]
     * | undefined`, and `AdoptBuilder.php`'s own `(array)$entrypoint` cast
     * defends against the same possibility. A live Docker inspect always
     * returns an array in practice; this is carried through anyway so the
     * type-level check at the bottom of this file (proving Dockerode really
     * does satisfy `DockerFoldersExtraDockerClient`) does not silently pass
     * only because a mismatch happened to land on an optional field.
     */
    Entrypoint?: string | string[] | null;
}

export interface DockerFoldersRawNetworkSettings {
    Networks?: Record<string, { IPAMConfig?: { IPv4Address?: string } | null } | null> | null;
}

/**
 * The wide inspect shape `AdoptBuilder` and the stats orchestration both need
 * (`Mounts`, full `HostConfig`, `RestartCount`, `State.StartedAt`). Wider than
 * `docker-client.ts`'s `DockerInspectInfo`, which only carries what the
 * container-list and action services read.
 */
export interface DockerFoldersRawInspect {
    /**
     * The full 64-char container id. Always present on a real inspect; used
     * by the fast stats path's slow-data refresh, mirroring
     * `DockerClient.php`'s `$fullId = $inspect['Id'] ?? $id;`.
     */
    Id?: string;
    Name?: string;
    Image?: string;
    RestartCount?: number;
    State?: { StartedAt?: string; Paused?: boolean };
    Config?: DockerFoldersRawConfig | null;
    HostConfig?: DockerFoldersRawHostConfig | null;
    Mounts?: DockerFoldersRawMount[] | null;
    NetworkSettings?: DockerFoldersRawNetworkSettings | null;
}

export interface DockerFoldersRawImageInspect {
    Config?: {
        Env?: string[] | null;
        Labels?: Record<string, string> | null;
        Cmd?: string[] | null;
        /** See the comment on `DockerFoldersRawConfig.Entrypoint`. */
        Entrypoint?: string | string[] | null;
        User?: string;
    } | null;
    Size?: number;
}

/** One field of Docker's stats JSON. See `container-stats.ts` for the math. */
export interface DockerFoldersRawStats {
    /** Full 64-char container id, echoed back by Docker. Absent only in fakes. */
    id?: string;
    cpu_stats?: {
        cpu_usage?: { total_usage?: number; percpu_usage?: number[] | null };
        system_cpu_usage?: number;
        online_cpus?: number;
    };
    precpu_stats?: {
        cpu_usage?: { total_usage?: number };
        system_cpu_usage?: number;
    };
    memory_stats?: { usage?: number; limit?: number };
    blkio_stats?: { io_service_bytes_recursive?: { op?: string; value?: number }[] | null } | null;
    networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }> | null;
    pids_stats?: { current?: number };
}

export interface DockerFoldersLogsOptions {
    stdout: boolean;
    stderr: boolean;
    timestamps: boolean;
    tail: number;
    follow: false;
}

/**
 * The `follow: true` counterpart to `DockerFoldersLogsOptions`. Dockerode
 * really does return a different value shape depending on `follow` — see the
 * overload on `logs()` below — so this is a separate interface rather than
 * `follow: boolean` on the one above; that would force every caller of the
 * one-shot `logs()` to narrow the return type itself.
 */
export interface DockerFoldersFollowLogsOptions {
    stdout: boolean;
    stderr: boolean;
    timestamps: boolean;
    tail: number;
    follow: true;
}

export interface DockerFoldersExtraContainerHandle {
    inspect(): Promise<DockerFoldersRawInspect>;
    /**
     * Dockerode resolves a non-follow request with the raw response body as a
     * `Buffer`. For a container created without a TTY that body is Docker's
     * 8-byte-framed multiplexed stream (stdout/stderr interleaved); for a TTY
     * container it is the raw bytes. `container-logs.ts` sniffs which one it
     * got, the same way `DockerClient::looksMultiplexed` does.
     */
    logs(options: DockerFoldersLogsOptions): Promise<Buffer>;
    /**
     * With `follow: true`, dockerode resolves with a live `NodeJS.ReadableStream`
     * of the same framing instead of a single `Buffer` — chunks arrive over
     * time and a chunk boundary can land anywhere (mid frame-header, mid
     * payload, mid line, mid UTF-8 character). `container-logs.ts`'s
     * `LogStreamDecoder` is the incremental counterpart to the one-shot
     * sniff-and-demux `container-logs.ts` does for the `Buffer` overload
     * above.
     */
    logs(options: DockerFoldersFollowLogsOptions): Promise<NodeJS.ReadableStream>;
    /** `{stream: false}` resolves with one parsed JSON sample, not a stream. */
    stats(options: { stream: false }): Promise<DockerFoldersRawStats>;
}

export interface DockerFoldersExtraImageHandle {
    inspect(): Promise<DockerFoldersRawImageInspect>;
}

export interface DockerFoldersExtraNetworkHandle {
    inspect(): Promise<{ Driver?: string }>;
}

export interface DockerFoldersExtraDockerClient {
    getContainer(id: string): DockerFoldersExtraContainerHandle;
    getImage(id: string): DockerFoldersExtraImageHandle;
    getNetwork(name: string): DockerFoldersExtraNetworkHandle;
}

/**
 * Re-exported so this file's consumers only ever import from here, not from
 * `docker-client.ts` directly. Only the token value is taken from there — a
 * plain string constant, stable regardless of what that file's own types do
 * while it is being edited concurrently. `index.ts`'s single
 * `dockerClientProvider` binds the real Dockerode instance to this same
 * string key, and Dockerode satisfies both this interface and the narrower
 * one in `docker-client.ts` structurally, so one provider serves both.
 */
export { DOCKER_CLIENT_TOKEN } from './docker-client.js';

/**
 * Type-only proof that Dockerode really does satisfy this interface
 * structurally, the same proof `docker-client.ts` has for its own (narrower)
 * interface: `const client: DockerClient = new Dockerode(...)`. Asserting it
 * here matters because `@Inject(DOCKER_CLIENT_TOKEN)` binds by string at
 * runtime — nothing about that wiring ever compares Dockerode's real shape
 * against this interface, so without this line a hand-written mismatch here
 * would type-check cleanly and only fail at 3 a.m. against a real socket.
 *
 * `import type` erases completely at build time; nothing here adds a runtime
 * dependency on `dockerode`; and this cast never runs (`as` casts a type, it
 * does not construct a value, and the file's default export is never used).
 * Checked against `@types/dockerode` 3.x: every field this file declares as
 * optional is `any` or a required field on the real type (assignable either
 * way), except `Config.Entrypoint`, which the real type also allows as a bare
 * `string` — carried into `DockerFoldersRawConfig` above for exactly that
 * reason, with `postArgs` in `adopt-builder.ts` handling both shapes.
 */
import type Dockerode from 'dockerode';

// Type-level only: `as Dockerode` casts a type, it constructs nothing, and
// this binding is never read. If a future `@types/dockerode` upgrade narrows
// or renames a field this interface depends on, this line — not a 3 a.m.
// production error — is what fails.
const _dockerodeSatisfiesExtras: DockerFoldersExtraDockerClient = {} as Dockerode;
void _dockerodeSatisfiesExtras;
