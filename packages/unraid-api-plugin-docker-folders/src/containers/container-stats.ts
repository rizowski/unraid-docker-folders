import type { DockerFoldersRawInspect, DockerFoldersRawStats } from './extras-docker-client.js';

/**
 * The live resource stats math, ported from `DockerClient`'s five
 * `calculate*` private methods and the assembly `fetchBatchStats` does around
 * them (DockerClient.php:1159-1240). This is the "slow", Docker-API-based
 * path — `stats.php` actually calls `fetchBatchStatsFast` first, which reads
 * `/sys/fs/cgroup` and `/proc` directly and falls back to this path only when
 * the cgroup layout cannot be detected. That fast path IS ported (see
 * `cgroup-stats.ts` for the reads and `container-stats.service.ts` for the
 * dispatch between the two, mirroring `fetchBatchStatsFast`'s own fallback);
 * this file stays the fallback target, exactly as it is in PHP.
 *
 * `round2` and `cpuPercentFromDelta` are exported because the fast path needs
 * the identical rounding and CPU-delta formula against cgroup-sourced deltas
 * instead of Docker-stats-sourced ones — one formula, not two copies that
 * could drift.
 *
 * Every function here is exercised directly against `DockerClientStatsTest`'s
 * fixtures, translated into vitest, in `__tests__/container-stats.spec.ts`.
 */

export interface CpuPercentResult {
    /** Percent, 0-100 per core times online CPUs, rounded to 2 decimals. */
    percent: number;
}

export interface MemoryStatsResult {
    usage: number;
    limit: number;
    percent: number;
}

export interface BlockIoResult {
    read: number;
    write: number;
}

export interface NetworkIoResult {
    rx: number;
    tx: number;
}

/** PHP's `round($x, 2)`. Half-away-from-zero, which `Math.round` matches for
 * the non-negative values these functions only ever produce. */
export function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * The one CPU-percent formula both stats paths share:
 * `(cpuDelta / systemDelta) * onlineCpus * 100`, guarded against a zero or
 * negative system delta (a sample taken before the container has run long
 * enough to have two distinct readings) and a negative CPU delta (a counter
 * reset, which a container restart between the two samples can cause).
 *
 * `calculateCpuPercent` below computes its deltas from one Docker stats
 * sample's `cpu_stats`/`precpu_stats` pair; the fast path
 * (`cgroup-stats.ts` + `container-stats.service.ts`) computes the same deltas
 * from two cgroup reads taken seconds apart, kept in memory between calls.
 * Both then call this.
 */
export function cpuPercentFromDelta(cpuDelta: number, systemDelta: number, onlineCpus: number): number {
    if (systemDelta > 0 && cpuDelta >= 0) {
        return round2((cpuDelta / systemDelta) * onlineCpus * 100);
    }
    return 0.0;
}

/**
 * `DockerClient::calculateCpuPercent`. The online-CPU count comes from
 * `getHostCpuCount` (below), not a bare `cpu_stats.online_cpus ?? 1` — the
 * frontend divides a summed `cpuPercent` by the `hostCpus` this same stats
 * entry reports, so the two must agree on the same fallback chain or the
 * aggregate comes out scaled wrong on a payload that omits `online_cpus` but
 * still carries `percpu_usage`.
 */
export function calculateCpuPercent(stats: DockerFoldersRawStats): number {
    const cpuStats = stats.cpu_stats ?? {};
    const preCpuStats = stats.precpu_stats ?? {};

    const cpuDelta = (cpuStats.cpu_usage?.total_usage ?? 0) - (preCpuStats.cpu_usage?.total_usage ?? 0);
    const systemDelta = (cpuStats.system_cpu_usage ?? 0) - (preCpuStats.system_cpu_usage ?? 0);
    const onlineCpus = getHostCpuCount(stats);

    return cpuPercentFromDelta(cpuDelta, systemDelta, onlineCpus);
}

/**
 * `DockerClient::calculateMemoryStats`.
 *
 * Raw `usage` over `limit` — no cache subtraction. (Some Docker stats
 * consumers subtract page cache from `usage` for a "true" figure; this plugin
 * does not, and the PHP it is ported from does not either, confirmed against
 * `memoryStats_normal_usage`, which asserts the raw `usage` value passes
 * through unchanged.)
 *
 * `limit` defaults to 1, not 0, when missing — division-by-zero bait if it
 * defaulted to 0 the way `usage` does. An *explicit* 0 limit is left alone
 * (PHP's `??` and JS's `??` both only trigger on a missing/null value, never
 * on 0) and produces a 0 percent through the separate `limit > 0` guard.
 */
export function calculateMemoryStats(stats: DockerFoldersRawStats): MemoryStatsResult {
    const memStats = stats.memory_stats ?? {};
    const usage = memStats.usage ?? 0;
    const limit = memStats.limit ?? 1;

    return { usage, limit, percent: memoryPercent(usage, limit) };
}

/**
 * `usage / limit * 100`, shared with the fast path's memory percent
 * (`fetchBatchStatsFast`'s `$memPercent = $memLimit > 0 ? round(...) : 0`,
 * DockerClient.php:1099) — same formula, same 0-when-non-positive guard.
 */
export function memoryPercent(usage: number, limit: number): number {
    return limit > 0 ? round2((usage / limit) * 100) : 0;
}

/** `DockerClient::calculateBlockIO`. Sums recursive read/write byte counters, case-insensitively. */
export function calculateBlockIO(stats: DockerFoldersRawStats): BlockIoResult {
    let read = 0;
    let write = 0;
    const entries = stats.blkio_stats?.io_service_bytes_recursive ?? [];

    for (const entry of entries) {
        const op = (entry.op ?? '').toLowerCase();
        if (op === 'read') {
            read += entry.value ?? 0;
        } else if (op === 'write') {
            write += entry.value ?? 0;
        }
    }

    return { read, write };
}

/** `DockerClient::calculateNetworkIO`. Sums rx/tx across every interface Docker reports. */
export function calculateNetworkIO(stats: DockerFoldersRawStats): NetworkIoResult {
    let rx = 0;
    let tx = 0;
    const networks = stats.networks ?? {};

    for (const iface of Object.values(networks)) {
        rx += iface?.rx_bytes ?? 0;
        tx += iface?.tx_bytes ?? 0;
    }

    return { rx, tx };
}

/** `DockerClient::calculatePids`. */
export function calculatePids(stats: DockerFoldersRawStats): number {
    return stats.pids_stats?.current ?? 0;
}

/**
 * `DockerClient::getHostCpuCount`. Docker reports `cpu_stats.online_cpus` on
 * modern kernels; older ones omit it, so this falls back to the length of the
 * `percpu_usage` array, and then to 1 if neither is present.
 */
export function getHostCpuCount(stats: DockerFoldersRawStats): number {
    const cpuStats = stats.cpu_stats ?? {};
    // `!= null` (not `!== undefined`): PHP's `isset()` treats an explicit
    // `null` as missing too, and a `null` reaching the non-null `hostCpus`
    // GraphQL `Int` field would fail that entry.
    if (cpuStats.online_cpus != null) {
        return cpuStats.online_cpus;
    }

    const percpu = cpuStats.cpu_usage?.percpu_usage ?? [];
    if (percpu.length > 0) {
        return percpu.length;
    }

    return 1;
}

/** The shape `stores/stats.ts`'s `ContainerStats` interface expects. */
export interface DockerFoldersContainerStatsResult {
    cpuPercent: number;
    memoryUsage: number;
    memoryLimit: number;
    memoryPercent: number;
    blockRead: number;
    blockWrite: number;
    netRx: number;
    netTx: number;
    pids: number;
    restartCount: number;
    startedAt: string;
    imageSize: number;
    logSize: number;
    hostCpus: number;
    hostMemory: number;
}

/**
 * Assemble one container's formatted stats, mirroring the per-id body of
 * `DockerClient::fetchBatchStats` (DockerClient.php:1196-1233). Pure: the
 * I/O — fetching `stats`, `inspect`, image size, and log size — is
 * `ContainerStatsService`'s job, so this can be tested without any of it.
 * `hostMemory` is likewise supplied by the caller (`readSystemMemoryTotalBytes`
 * reads `/proc/meminfo`); `hostCpus` is derived from `stats` itself and so is
 * computed here.
 */
export function buildContainerStats(
    stats: DockerFoldersRawStats,
    inspect: DockerFoldersRawInspect | null,
    imageSize: number,
    logSize: number,
    hostMemory: number
): DockerFoldersContainerStatsResult {
    const cpu = calculateCpuPercent(stats);
    const mem = calculateMemoryStats(stats);
    const blockIO = calculateBlockIO(stats);
    const netIO = calculateNetworkIO(stats);
    const pids = calculatePids(stats);

    return {
        cpuPercent: cpu,
        memoryUsage: mem.usage,
        memoryLimit: mem.limit,
        memoryPercent: mem.percent,
        blockRead: blockIO.read,
        blockWrite: blockIO.write,
        netRx: netIO.rx,
        netTx: netIO.tx,
        pids,
        restartCount: inspect?.RestartCount ?? 0,
        startedAt: inspect?.State?.StartedAt ?? '',
        imageSize,
        logSize,
        hostCpus: getHostCpuCount(stats),
        hostMemory,
    };
}
