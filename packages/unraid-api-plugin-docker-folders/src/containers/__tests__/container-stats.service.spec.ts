import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clampStatsInterval,
    containerLogSize,
    ContainerStatsService,
    type CpuSampleHolder,
} from '../container-stats.service.js';
import type {
    DockerFoldersExtraContainerHandle,
    DockerFoldersExtraDockerClient,
    DockerFoldersRawImageInspect,
    DockerFoldersRawInspect,
    DockerFoldersRawStats,
} from '../extras-docker-client.js';

function fakeDocker(overrides: {
    stats?: (id: string) => Promise<DockerFoldersRawStats>;
    inspect?: (id: string) => Promise<DockerFoldersRawInspect>;
    imageInspect?: (id: string) => Promise<DockerFoldersRawImageInspect>;
}): DockerFoldersExtraDockerClient {
    return {
        getContainer: (id: string) => ({
            inspect: () => (overrides.inspect ? overrides.inspect(id) : Promise.resolve({})),
            // `logs()` is never called by ContainerStatsService; cast only to
            // satisfy its two-overload type.
            logs: (() =>
                Promise.reject(new Error('not used here'))) as unknown as DockerFoldersExtraContainerHandle['logs'],
            stats: () => (overrides.stats ? overrides.stats(id) : Promise.reject(new Error('not used here'))),
        }),
        getImage: (id: string) => ({
            inspect: () => (overrides.imageInspect ? overrides.imageInspect(id) : Promise.resolve({})),
        }),
        getNetwork: () => ({ inspect: () => Promise.reject(new Error('not used here')) }),
    };
}

describe('containerLogSize', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'container-log-size-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("reads the log file's size when the id is a well-formed full container id", () => {
        const id = 'a'.repeat(64);
        mkdirSync(join(dir, id));
        writeFileSync(join(dir, id, `${id}-json.log`), '0123456789', 'utf8');

        expect(containerLogSize(id, 'whatever', dir)).toBe(10);
    });

    it('falls back to the requested id only when it also looks like a container id', () => {
        const shortId = 'deadbeefcafe';
        mkdirSync(join(dir, shortId));
        writeFileSync(join(dir, shortId, `${shortId}-json.log`), 'hello', 'utf8');

        expect(containerLogSize(undefined, shortId, dir)).toBe(5);
    });

    /**
     * DockerClient::getContainerLogSize (DockerClient.php:649-657) builds its
     * path from `$stats['id'] ?? $id` with no validation on either — a
     * request-supplied id reaching a filesystem path unchecked, which
     * CLAUDE.md's Security section requires be gated. This is the port's
     * hardening: an id that is not plausibly a Docker container id (here, a
     * traversal attempt) is never used to build a path at all.
     */
    it('refuses an id shaped like a path traversal attempt and returns 0', () => {
        expect(containerLogSize(undefined, '../../etc/passwd', dir)).toBe(0);
    });

    it('returns 0 when the log file does not exist', () => {
        expect(containerLogSize('a'.repeat(64), 'whatever', dir)).toBe(0);
    });
});

/**
 * These ids ("abc", "bad", "good") never match `DOCKER_CONTAINER_ID_PATTERN`,
 * so `getStats` can never find a cgroup layout for them and always takes the
 * slow, Docker-API path — exactly the path these tests exercise. The fast
 * path (cgroup layout found, in-memory CPU/slow-data caching, and the
 * per-container fallback merge) is exercised separately below, against a
 * temp directory shaped like `/sys/fs/cgroup` and `/proc`.
 */
describe('ContainerStatsService (slow, Docker-API path)', () => {
    it('returns null for a container whose stats call fails', async () => {
        const service = new ContainerStatsService(
            fakeDocker({
                stats: () => Promise.reject(new Error('not running')),
            })
        );

        const result = await service.getStats(['abc']);
        expect(result.get('abc')).toBeNull();
    });

    it('assembles stats for a running container, tolerating a failed image inspect', async () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 1 },
            precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
            memory_stats: { usage: 100, limit: 200 },
            pids_stats: { current: 3 },
            id: 'a'.repeat(64),
        };
        const service = new ContainerStatsService(
            fakeDocker({
                stats: async () => stats,
                inspect: async () => ({ RestartCount: 1, State: { StartedAt: 'now' }, Image: 'sha256:deadbeef' }),
                imageInspect: () => Promise.reject(new Error('image gone')),
            })
        );

        const result = await service.getStats(['abc']);
        const entry = result.get('abc');

        expect(entry).not.toBeNull();
        expect(entry?.restartCount).toBe(1);
        expect(entry?.startedAt).toBe('now');
        expect(entry?.imageSize).toBe(0);
        expect(entry?.pids).toBe(3);
        expect(entry?.hostCpus).toBe(1);
        // The slow path has no `sources` override, so this reads the real
        // host's /proc/meminfo — present (and positive) on Linux, absent (0)
        // on a non-Linux test runner such as macOS. Either way it must be a
        // well-formed number, not undefined or NaN.
        expect(typeof entry?.hostMemory).toBe('number');
        expect(Number.isNaN(entry?.hostMemory ?? NaN)).toBe(false);
    });

    it('fetches every id in parallel, independent of one another', async () => {
        const service = new ContainerStatsService(
            fakeDocker({
                stats: async (id) => {
                    if (id === 'bad') throw new Error('nope');
                    return { pids_stats: { current: 1 } };
                },
            })
        );

        const result = await service.getStats(['good', 'bad']);

        expect(result.get('bad')).toBeNull();
        expect(result.get('good')?.pids).toBe(1);
    });
});

describe('ContainerStatsService (fast, cgroup path)', () => {
    const ID_A = 'a'.repeat(64);
    const ID_B = 'b'.repeat(64);

    let dir: string;
    let cgroupRoot: string;
    let procRoot: string;
    let sources: { cgroupRoot: string; procRoot: string };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'container-stats-fast-'));
        cgroupRoot = join(dir, 'sys-fs-cgroup');
        procRoot = join(dir, 'proc');
        mkdirSync(cgroupRoot, { recursive: true });
        mkdirSync(procRoot, { recursive: true });
        sources = { cgroupRoot, procRoot };

        writeFileSync(join(procRoot, 'stat'), 'cpu  1 1 1 1\ncpu0 1 1 1 1\n', 'utf8');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeContainerCgroup(id: string, opts: { cpuUsageUsec: number; memoryUsage: number }) {
        const d = join(cgroupRoot, 'docker', id);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'cpu.stat'), `usage_usec ${opts.cpuUsageUsec}\n`, 'utf8');
        writeFileSync(join(d, 'memory.current'), `${opts.memoryUsage}\n`, 'utf8');
        writeFileSync(join(d, 'memory.max'), 'max\n', 'utf8');
        writeFileSync(join(d, 'io.stat'), '8:0 rbytes=10 wbytes=20\n', 'utf8');
        writeFileSync(join(d, 'pids.current'), '2\n', 'utf8');
        writeFileSync(join(d, 'cgroup.procs'), '', 'utf8'); // no pid -> net stats default to 0, not exercised here
    }

    function service(overrides: {
        inspect?: (id: string) => Promise<DockerFoldersRawInspect>;
        imageInspect?: (id: string) => Promise<DockerFoldersRawImageInspect>;
    } = {}): ContainerStatsService {
        return new ContainerStatsService(fakeDocker(overrides));
    }

    it('uses the fast path once a cgroup layout is found, with no previous sample the first time', async () => {
        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 8000000 kB\n', 'utf8');

        const svc = service({
            inspect: async () => ({ Id: ID_A, RestartCount: 2, State: { StartedAt: 't0' }, Image: 'sha256:img' }),
            imageInspect: async () => ({ Size: 555 }),
        });

        const result = await svc.getStats([ID_A], sources);
        const entry = result.get(ID_A);

        expect(entry).not.toBeNull();
        // No previous CPU sample yet -> 0%, matching fetchBatchStatsFast's `if ($prev) {...}` guard.
        expect(entry?.cpuPercent).toBe(0);
        expect(entry?.memoryUsage).toBe(1024);
        // memory.max was "max" -> resolved against /proc/meminfo's MemTotal.
        expect(entry?.memoryLimit).toBe(8000000 * 1024);
        expect(entry?.blockRead).toBe(10);
        expect(entry?.blockWrite).toBe(20);
        expect(entry?.pids).toBe(2);
        expect(entry?.restartCount).toBe(2);
        expect(entry?.startedAt).toBe('t0');
        expect(entry?.imageSize).toBe(555);
        // /proc/stat in beforeEach has one online CPU line (cpu0).
        expect(entry?.hostCpus).toBe(1);
        expect(entry?.hostMemory).toBe(8000000 * 1024);
    });

    it('computes a real CPU percent on the second call, from the in-memory previous sample', async () => {
        writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 8000000 kB\n', 'utf8');
        const svc = service({
            inspect: async () => ({ Id: ID_A, Image: '' }),
        });

        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        await svc.getStats([ID_A], sources);

        // Advance both the container's cpu.stat and /proc/stat's system time,
        // simulating ~3 seconds passing: +500ms of cpu time on a 1-core box's
        // system clock advancing by 1s (10 jiffies).
        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_500_000, memoryUsage: 1024 });
        writeFileSync(join(procRoot, 'stat'), 'cpu  11 1 1 1\ncpu0 11 1 1 1\n', 'utf8');

        const result = await svc.getStats([ID_A], sources);
        const entry = result.get(ID_A);

        // cpuDelta = 1,500,000,000ns - 1,000,000,000ns = 500,000,000ns
        // systemDelta = 10 jiffies * 1e7 ns/jiffy = 100,000,000ns
        // (500,000,000 / 100,000,000) * 1 onlineCpu * 100 = 500.0
        expect(entry?.cpuPercent).toBe(500);
    });

    it('replaces the CPU sample set on every call, dropping a container missing from the current batch', async () => {
        const svc = service({ inspect: async () => ({ Id: ID_A, Image: '' }) });

        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        await svc.getStats([ID_A], sources);

        // ID_A is absent from this batch: its sample is dropped, not kept.
        await svc.getStats([], sources);

        writeContainerCgroup(ID_A, { cpuUsageUsec: 5_000_000, memoryUsage: 1024 });
        const result = await svc.getStats([ID_A], sources);

        // No previous sample survived the gap -> back to 0%, not a huge spike.
        expect(result.get(ID_A)?.cpuPercent).toBe(0);
    });

    it('falls back per-container to the slow path when a cgroup directory is missing', async () => {
        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        // ID_B has no cgroup directory at all.

        const svc = service({
            inspect: async (id) =>
                id === ID_B
                    ? ({ RestartCount: 9 } as DockerFoldersRawInspect)
                    : ({ Id: ID_A, Image: '' } as DockerFoldersRawInspect),
        });

        const result = await svc.getStats([ID_A, ID_B], sources);

        expect(result.get(ID_A)).not.toBeNull();
        // ID_B fell back to getOneSlow, which calls docker.stats() — the fake
        // rejects by default, so it resolves to null, matching a container
        // whose cgroup directory vanished (stopped, or genuinely unreadable).
        expect(result.get(ID_B)).toBeNull();
    });

    it('detects the cgroup layout once and keeps using the fast path even when a later sample id has no cgroup directory of its own', async () => {
        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        const svc = service({ inspect: async () => ({ Id: ID_A, Image: '' }) });

        // First call detects "v2-flat" from ID_A.
        await svc.getStats([ID_A], sources);

        // Second call's first id (ID_B) has no cgroup dir; if layout detection
        // ran again it would find nothing and this batch would take the slow
        // path entirely. Because detection is cached from the first call,
        // ID_A here still gets a real (non-null) fast-path result.
        const result = await svc.getStats([ID_B, ID_A], sources);
        expect(result.get(ID_A)).not.toBeNull();
    });

    it('reuses a cached slow-data entry within the TTL rather than re-inspecting', async () => {
        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        let inspectCalls = 0;
        const svc = service({
            inspect: async () => {
                inspectCalls++;
                return { Id: ID_A, RestartCount: inspectCalls, Image: '' };
            },
        });

        const first = await svc.getStats([ID_A], sources);
        const second = await svc.getStats([ID_A], sources);

        expect(inspectCalls).toBe(1);
        expect(first.get(ID_A)?.restartCount).toBe(1);
        expect(second.get(ID_A)?.restartCount).toBe(1);
    });

    it('dedupes image lookups by image id when refreshing the slow cache for several containers', async () => {
        writeContainerCgroup(ID_A, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });
        writeContainerCgroup(ID_B, { cpuUsageUsec: 1_000_000, memoryUsage: 1024 });

        let imageInspects = 0;
        const svc = service({
            inspect: async (id) => ({ Id: id, Image: 'sha256:shared' }),
            imageInspect: async () => {
                imageInspects++;
                return { Size: 42 };
            },
        });

        const result = await svc.getStats([ID_A, ID_B], sources);

        expect(imageInspects).toBe(1);
        expect(result.get(ID_A)?.imageSize).toBe(42);
        expect(result.get(ID_B)?.imageSize).toBe(42);
    });
});

describe('ContainerStatsService.statsStream', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function serviceWithReadings(): { service: ContainerStatsService; getStats: ReturnType<typeof vi.fn> } {
        const service = new ContainerStatsService(fakeDocker({}));
        const getStats = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, null] as const)));
        (service as unknown as { getStats: typeof getStats }).getStats = getStats;
        return { service, getStats };
    }

    it('sends a reading at once, then one per interval', async () => {
        const { service, getStats } = serviceWithReadings();
        const received: unknown[] = [];

        const subscription = service.statsStream(['a'], 2_000).subscribe((stats) => received.push(stats));
        await vi.advanceTimersByTimeAsync(0);
        expect(received).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(received).toHaveLength(3);
        expect(getStats).toHaveBeenCalledTimes(3);

        subscription.unsubscribe();
    });

    it('waits for a slow reading instead of starting the next one on top of it', async () => {
        const service = new ContainerStatsService(fakeDocker({}));
        let inFlight = 0;
        let maxInFlight = 0;
        (service as unknown as { getStats: () => Promise<Map<string, null>> }).getStats = async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            inFlight -= 1;
            return new Map();
        };

        const subscription = service.statsStream(['a'], 1_000).subscribe(() => undefined);
        await vi.advanceTimersByTimeAsync(20_000);
        subscription.unsubscribe();

        expect(maxInFlight).toBe(1);
    });

    it('stops reading once the subscriber goes away', async () => {
        const { service, getStats } = serviceWithReadings();

        const subscription = service.statsStream(['a'], 1_000).subscribe(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        subscription.unsubscribe();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(getStats).toHaveBeenCalledTimes(1);
    });

    it('keeps going after a failed reading', async () => {
        const service = new ContainerStatsService(fakeDocker({}));
        let call = 0;
        (service as unknown as { getStats: () => Promise<Map<string, null>> }).getStats = async () => {
            call += 1;
            if (call === 1) throw new Error('docker went away');
            return new Map([['a', null]]);
        };
        const received: unknown[] = [];

        const subscription = service.statsStream(['a'], 1_000).subscribe((stats) => received.push(stats));
        await vi.advanceTimersByTimeAsync(1_000);
        subscription.unsubscribe();

        expect(received).toHaveLength(1);
    });

    it('shares one reading between streams with the same interval, and sends each its own ids', async () => {
        const service = new ContainerStatsService(fakeDocker({}));
        const calls: { ids: string[]; holder: CpuSampleHolder }[] = [];
        (service as unknown as {
            getStats: (ids: string[], sources: unknown, holder: CpuSampleHolder) => Promise<Map<string, null>>;
        }).getStats = async (ids, _sources, holder) => {
            calls.push({ ids, holder });
            return new Map(ids.map((id) => [id, null]));
        };
        const first: Map<string, unknown>[] = [];
        const second: Map<string, unknown>[] = [];

        const a = service.statsStream(['a', 'b'], 2_000).subscribe((m) => first.push(m));
        const b = service.statsStream(['b', 'c'], 2_000).subscribe((m) => second.push(m));
        await vi.advanceTimersByTimeAsync(0);
        const afterJoin = calls.length;
        await vi.advanceTimersByTimeAsync(2_000);

        expect(calls.length - afterJoin).toBe(1);
        expect([...calls.at(-1)!.ids].sort()).toEqual(['a', 'b', 'c']);
        expect([...first.at(-1)!.keys()]).toEqual(['a', 'b']);
        expect([...second.at(-1)!.keys()]).toEqual(['b', 'c']);
        expect(new Set(calls.map((c) => c.holder)).size).toBe(1);
        expect(calls[0].holder).not.toBe((service as unknown as { cpuSamples: CpuSampleHolder }).cpuSamples);

        a.unsubscribe();
        b.unsubscribe();
    });

    it('runs a separate loop for a different interval, and stops a loop when its last stream leaves', async () => {
        const { service, getStats } = serviceWithReadings();

        const fast = service.statsStream(['a'], 1_000).subscribe(() => undefined);
        const slow = service.statsStream(['a'], 10_000).subscribe(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(getStats).toHaveBeenCalledTimes(2);

        fast.unsubscribe();
        await vi.advanceTimersByTimeAsync(9_000);
        expect(getStats).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(getStats).toHaveBeenCalledTimes(3);
        slow.unsubscribe();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getStats).toHaveBeenCalledTimes(3);
    });

    it('sends a new stream a reading at once, without waiting for the interval', async () => {
        const { service } = serviceWithReadings();
        const first = service.statsStream(['a'], 60_000).subscribe(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        const received: unknown[] = [];
        const second = service.statsStream(['b'], 60_000).subscribe((m) => received.push(m));
        await vi.advanceTimersByTimeAsync(0);

        expect(received).toHaveLength(1);
        first.unsubscribe();
        second.unsubscribe();
    });

    it('bounds the interval', () => {
        expect(clampStatsInterval(10)).toBe(1_000);
        expect(clampStatsInterval(10_000_000)).toBe(300_000);
        expect(clampStatsInterval(undefined)).toBe(5_000);
        expect(clampStatsInterval(Number.NaN)).toBe(5_000);
        expect(clampStatsInterval(15_000)).toBe(15_000);
    });
});
