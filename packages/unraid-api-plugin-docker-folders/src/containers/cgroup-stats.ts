import { readFileSync, statSync } from 'node:fs';

/**
 * Reads Docker's own cgroup accounting straight off `/sys/fs/cgroup` and
 * `/proc`, ported from the private helpers `DockerClient::fetchBatchStatsFast`
 * uses: `detectCgroupLayout`, `getCgroupDir`, `readSystemCpuInfo`,
 * `readCgroupStats`, `readCgroupV1Stats`, and `readNetworkStats`
 * (DockerClient.php:772-965).
 *
 * `stats.php` calls `fetchBatchStatsFast` first, always — the slow,
 * Docker-API-based path in `container-stats.ts` is only its fallback for a
 * container (or a whole host) whose cgroup layout can't be read. This file is
 * the fast path itself.
 *
 * Every text-parsing function here is pure (a string in, a number or a small
 * record out) so the regex and byte-offset logic can be tested directly
 * against fixture text with no filesystem at all. The functions that DO touch
 * disk take an optional `CgroupSources` — `cgroupRoot`/`procRoot` — the same
 * shape `unraid-templates.ts`'s `TemplateSources` uses for the same reason:
 * tests point them at a temp directory built to look like `/sys/fs/cgroup`
 * and `/proc`, and production code never passes anything.
 */

export type CgroupLayout = 'v2-systemd' | 'v2-flat' | 'v1';

export interface CgroupSources {
    cgroupRoot?: string;
    procRoot?: string;
}

export const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup';
export const DEFAULT_PROC_ROOT = '/proc';

/**
 * A full or short Docker container id: lowercase hex, 12-64 characters.
 * Every function below that turns an id into a filesystem path checks it
 * against this first — the same hardening `container-stats.service.ts`'s
 * `containerLogSize` applies, and for the same reason: PHP builds these paths
 * from the id with no validation at all, and CLAUDE.md's Security section
 * requires one at this boundary regardless. Exported so `containerLogSize`
 * uses this single definition instead of keeping its own copy.
 */
export const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;

/** cgroup v1 reports a huge (but finite) number for "no limit" rather than an actual sentinel; cgroup v2 reports the literal string "max". Both normalise to this. */
export const MEMORY_UNLIMITED = -1;

// ---------------------------------------------------------------------------
// Pure text parsing
// ---------------------------------------------------------------------------

function parseIntOrZero(value: string): number {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** `cpu.stat`'s `usage_usec` is microseconds; converted to nanoseconds to match cgroup v1 and Docker's own convention. `null` when the line is missing. */
export function parseCgroupV2CpuUsageNs(cpuStatText: string): number | null {
    const match = /usage_usec\s+(\d+)/.exec(cpuStatText);
    return match === null ? null : parseIntOrZero(match[1]) * 1000;
}

/** `cpuacct.usage` is already nanoseconds. */
export function parseCgroupV1CpuUsageNs(text: string): number {
    return parseIntOrZero(text.trim());
}

export function parseMemoryCurrent(text: string): number {
    return parseIntOrZero(text.trim());
}

/** `memory.max`: a byte count, or the literal string `max`. */
export function parseCgroupV2MemoryMax(text: string): number {
    const value = text.trim();
    return value === 'max' ? MEMORY_UNLIMITED : parseIntOrZero(value);
}

/** `memory.limit_in_bytes`: cgroup v1 reports a number past 1e17 rather than a sentinel when there is no limit. */
export function parseCgroupV1MemoryLimit(text: string): number {
    const value = parseIntOrZero(text.trim());
    return value > 1e17 ? MEMORY_UNLIMITED : value;
}

/** `io.stat`: one line per device, `rbytes=`/`wbytes=` among other `key=value` pairs. Summed across every device. */
export function parseCgroupV2IoStat(text: string): { read: number; write: number } {
    let read = 0;
    let write = 0;

    for (const line of text.split('\n')) {
        const r = /rbytes=(\d+)/.exec(line);
        if (r !== null) read += parseIntOrZero(r[1]);
        const w = /wbytes=(\d+)/.exec(line);
        if (w !== null) write += parseIntOrZero(w[1]);
    }

    return { read, write };
}

/** `blkio.throttle.io_service_bytes`: `<major>:<minor> <Op> <value>` per line, `Op` case-insensitive. */
export function parseCgroupV1BlkioThrottle(text: string): { read: number; write: number } {
    let read = 0;
    let write = 0;

    for (const rawLine of text.split('\n')) {
        const parts = rawLine.trim().split(/\s+/);
        if (parts.length !== 3) continue;

        const op = parts[1].toLowerCase();
        if (op === 'read') read += parseIntOrZero(parts[2]);
        if (op === 'write') write += parseIntOrZero(parts[2]);
    }

    return { read, write };
}

export function parsePidsCurrent(text: string): number {
    return parseIntOrZero(text.trim());
}

/** `/proc/stat`'s first line: `cpu  <user> <nice> <system> <idle> ...`, jiffies (100/sec) converted to nanoseconds. */
export function parseProcStatSystemTimeNs(procStatText: string): number {
    const firstLine = procStatText.split('\n')[0] ?? '';
    const parts = firstLine.split(/\s+/);
    if (parts.length < 5) return 0;

    let total = 0;
    for (let i = 1; i < parts.length; i++) total += parseIntOrZero(parts[i]);

    // 1e7 ns per jiffy (100 jiffies/sec on Linux).
    return total * 10_000_000;
}

/** `/proc/stat`'s per-CPU lines (`cpu0`, `cpu1`, ...), counted rather than parsed for their values. */
export function parseOnlineCpuCount(procStatText: string): number {
    const matches = procStatText.match(/^cpu\d+/gm);
    return matches === null || matches.length === 0 ? 1 : matches.length;
}

/** `/proc/{pid}/net/dev`: `<iface>: <rx...9 fields...>`, `lo` excluded, rx is field 0 and tx is field 8. */
export function parseNetDevCounters(netDevText: string): { rx: number; tx: number } {
    let rx = 0;
    let tx = 0;

    for (const rawLine of netDevText.split('\n')) {
        const line = rawLine.trim();
        const colon = line.indexOf(':');
        if (colon === -1) continue;

        const iface = line.slice(0, colon).trim();
        if (iface === 'lo') continue;

        const fields = line
            .slice(colon + 1)
            .trim()
            .split(/\s+/);
        if (fields.length >= 9) {
            rx += parseIntOrZero(fields[0]);
            tx += parseIntOrZero(fields[8]);
        }
    }

    return { rx, tx };
}

/** `cgroup.procs`: one PID per line. `null` when empty or the first entry isn't a positive integer. */
export function parseFirstPid(cgroupProcsText: string): number | null {
    const first = cgroupProcsText.trim().split('\n')[0] ?? '';
    const pid = parseIntOrZero(first);
    return pid > 0 ? pid : null;
}

/** `/proc/meminfo`'s `MemTotal:` line, kB converted to bytes. */
export function parseMemInfoTotalBytes(memInfoText: string): number {
    const match = /MemTotal:\s+(\d+)\s+kB/.exec(memInfoText);
    return match === null ? 0 : parseIntOrZero(match[1]) * 1024;
}

// ---------------------------------------------------------------------------
// Filesystem reads (root injectable; production passes nothing)
// ---------------------------------------------------------------------------

function readFileIfPresent(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function cgroupDir(layout: CgroupLayout, fullId: string, cgroupRoot: string, subsystem?: string): string {
    switch (layout) {
        case 'v2-systemd':
            return `${cgroupRoot}/system.slice/docker-${fullId}.scope`;
        case 'v2-flat':
            return `${cgroupRoot}/docker/${fullId}`;
        case 'v1':
            return `${cgroupRoot}/${subsystem ?? 'cpu'}/docker/${fullId}`;
    }
}

/**
 * Which cgroup layout this host uses, detected from one known container id.
 * `DockerClient` caches this in a static class property, detected once and
 * kept for the life of the (short-lived, PHP-FPM) process; the equivalent
 * cache here is `ContainerStatsService`'s own instance field, kept for the
 * life of the (long-running) Node process — a host's cgroup layout cannot
 * change without a reboot, so both are really caching "for as long as this
 * process could possibly run".
 */
export function detectCgroupLayout(fullId: string, sources: CgroupSources = {}): CgroupLayout | null {
    if (!DOCKER_CONTAINER_ID_PATTERN.test(fullId)) return null;

    const cgroupRoot = sources.cgroupRoot ?? DEFAULT_CGROUP_ROOT;

    for (const layout of ['v2-systemd', 'v2-flat', 'v1'] as const) {
        if (isDirectory(cgroupDir(layout, fullId, cgroupRoot))) return layout;
    }
    return null;
}

export interface SystemCpuInfo {
    systemTime: number;
    onlineCpus: number;
}

export function readSystemCpuInfo(sources: CgroupSources = {}): SystemCpuInfo {
    const text = readFileIfPresent(`${sources.procRoot ?? DEFAULT_PROC_ROOT}/stat`);
    if (text === null) return { systemTime: 0, onlineCpus: 1 };

    return { systemTime: parseProcStatSystemTimeNs(text), onlineCpus: parseOnlineCpuCount(text) };
}

export interface CgroupContainerStats {
    cpuUsage: number;
    systemTime: number;
    onlineCpus: number;
    memoryUsage: number;
    memoryLimit: number;
    ioRead: number;
    ioWrite: number;
    pids: number;
}

/**
 * One container's cgroup counters. `null` means "could not be read this
 * way" — the id doesn't look like a Docker id, or (v2 only) its cgroup
 * directory doesn't exist — and the caller falls back to the slow,
 * Docker-API path for that one container, exactly as
 * `DockerClient::readCgroupStats` returning `null` triggers
 * `fetchBatchStatsFast`'s `$fallbackSet`.
 */
export function readCgroupContainerStats(
    fullId: string,
    layout: CgroupLayout,
    systemCpu: SystemCpuInfo,
    sources: CgroupSources = {}
): CgroupContainerStats | null {
    if (!DOCKER_CONTAINER_ID_PATTERN.test(fullId)) return null;

    const cgroupRoot = sources.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
    const result: CgroupContainerStats = {
        cpuUsage: 0,
        systemTime: systemCpu.systemTime,
        onlineCpus: systemCpu.onlineCpus,
        memoryUsage: 0,
        memoryLimit: 0,
        ioRead: 0,
        ioWrite: 0,
        pids: 0,
    };

    if (layout === 'v1') {
        return readCgroupV1Stats(fullId, cgroupRoot, result);
    }

    const dir = cgroupDir(layout, fullId, cgroupRoot);
    if (!isDirectory(dir)) return null;

    const cpuStat = readFileIfPresent(`${dir}/cpu.stat`);
    if (cpuStat !== null) {
        const usage = parseCgroupV2CpuUsageNs(cpuStat);
        if (usage !== null) result.cpuUsage = usage;
    }

    const memCurrent = readFileIfPresent(`${dir}/memory.current`);
    if (memCurrent !== null) result.memoryUsage = parseMemoryCurrent(memCurrent);

    const memMax = readFileIfPresent(`${dir}/memory.max`);
    if (memMax !== null) result.memoryLimit = parseCgroupV2MemoryMax(memMax);

    const ioStat = readFileIfPresent(`${dir}/io.stat`);
    if (ioStat !== null) {
        const io = parseCgroupV2IoStat(ioStat);
        result.ioRead = io.read;
        result.ioWrite = io.write;
    }

    const pidsCurrent = readFileIfPresent(`${dir}/pids.current`);
    if (pidsCurrent !== null) result.pids = parsePidsCurrent(pidsCurrent);

    return result;
}

function readCgroupV1Stats(fullId: string, cgroupRoot: string, result: CgroupContainerStats): CgroupContainerStats {
    const cpuUsage = readFileIfPresent(`${cgroupDir('v1', fullId, cgroupRoot, 'cpuacct')}/cpuacct.usage`);
    if (cpuUsage !== null) result.cpuUsage = parseCgroupV1CpuUsageNs(cpuUsage);

    const memDir = cgroupDir('v1', fullId, cgroupRoot, 'memory');
    const memUsage = readFileIfPresent(`${memDir}/memory.usage_in_bytes`);
    if (memUsage !== null) result.memoryUsage = parseMemoryCurrent(memUsage);

    const memLimit = readFileIfPresent(`${memDir}/memory.limit_in_bytes`);
    if (memLimit !== null) result.memoryLimit = parseCgroupV1MemoryLimit(memLimit);

    const blkio = readFileIfPresent(
        `${cgroupDir('v1', fullId, cgroupRoot, 'blkio')}/blkio.throttle.io_service_bytes`
    );
    if (blkio !== null) {
        const io = parseCgroupV1BlkioThrottle(blkio);
        result.ioRead = io.read;
        result.ioWrite = io.write;
    }

    const pidsCurrent = readFileIfPresent(`${cgroupDir('v1', fullId, cgroupRoot, 'pids')}/pids.current`);
    if (pidsCurrent !== null) result.pids = parsePidsCurrent(pidsCurrent);

    return result;
}

/**
 * A container's network counters, read from `/proc/{pid}/net/dev` of the
 * first PID in its cgroup — there is no per-container network cgroup
 * subsystem, so this is the same indirection `DockerClient::readNetworkStats`
 * uses.
 */
export function readNetworkStatsForContainer(
    fullId: string,
    layout: CgroupLayout,
    sources: CgroupSources = {}
): { rx: number; tx: number } {
    if (!DOCKER_CONTAINER_ID_PATTERN.test(fullId)) return { rx: 0, tx: 0 };

    const cgroupRoot = sources.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
    const procRoot = sources.procRoot ?? DEFAULT_PROC_ROOT;

    // v1 has a dedicated `pids` subsystem directory; v2's single unified
    // directory serves every subsystem, `pids` included — mirrors
    // `DockerClient::readNetworkStats`'s own two-branch path build exactly.
    const procsPath =
        layout === 'v1'
            ? `${cgroupDir('v1', fullId, cgroupRoot, 'pids')}/cgroup.procs`
            : `${cgroupDir(layout, fullId, cgroupRoot)}/cgroup.procs`;

    const procsText = readFileIfPresent(procsPath);
    if (procsText === null) return { rx: 0, tx: 0 };

    const pid = parseFirstPid(procsText);
    if (pid === null) return { rx: 0, tx: 0 };

    const netDev = readFileIfPresent(`${procRoot}/${pid}/net/dev`);
    if (netDev === null) return { rx: 0, tx: 0 };

    return parseNetDevCounters(netDev);
}

/** Total system memory, used to resolve `MEMORY_UNLIMITED` into a real byte count for `memoryPercent`. */
export function readSystemMemoryTotalBytes(sources: CgroupSources = {}): number {
    const text = readFileIfPresent(`${sources.procRoot ?? DEFAULT_PROC_ROOT}/meminfo`);
    return text === null ? 0 : parseMemInfoTotalBytes(text);
}
