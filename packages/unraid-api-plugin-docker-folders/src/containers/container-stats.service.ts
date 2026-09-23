import { statSync } from 'node:fs';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';

import {
    DOCKER_CONTAINER_ID_PATTERN,
    MEMORY_UNLIMITED,
    detectCgroupLayout,
    readCgroupContainerStats,
    readNetworkStatsForContainer,
    readSystemCpuInfo,
    readSystemMemoryTotalBytes,
    type CgroupContainerStats,
    type CgroupLayout,
    type CgroupSources,
} from './cgroup-stats.js';
import { buildContainerStats, cpuPercentFromDelta, memoryPercent, type DockerFoldersContainerStatsResult } from './container-stats.js';
import {
    DOCKER_CLIENT_TOKEN,
    type DockerFoldersExtraDockerClient,
    type DockerFoldersRawInspect,
} from './extras-docker-client.js';

/** `DockerClient::getContainerLogSize`'s path, unchanged. */
export const DOCKER_CONTAINERS_ROOT = '/var/lib/docker/containers';

/**
 * Size of a container's JSON log file, in bytes.
 *
 * `DockerClient::getContainerLogSize` (DockerClient.php:649-657) builds its
 * path from an id with no validation at all, which CLAUDE.md's Security
 * section requires for every request-influenced path. This port closes it: a
 * candidate id is only used when it matches `DOCKER_CONTAINER_ID_PATTERN`
 * (the same gate `cgroup-stats.ts` applies before building a cgroup path),
 * and this returns 0 (matching PHP's own "file not found" behaviour) rather
 * than reading anything otherwise.
 *
 * `containersRoot` is a parameter, not a constant read directly, purely so
 * tests can point it at a temporary directory — the same reason
 * `unraid-templates.ts` takes a `TemplateSources` argument.
 */
export function containerLogSize(
    statsId: string | undefined,
    requestedId: string,
    containersRoot: string = DOCKER_CONTAINERS_ROOT
): number {
    const id = [statsId, requestedId].find(
        (candidate) => candidate !== undefined && DOCKER_CONTAINER_ID_PATTERN.test(candidate)
    );
    if (id === undefined) return 0;

    try {
        return statSync(join(containersRoot, id, `${id}-json.log`)).size;
    } catch {
        return 0;
    }
}

/** One container's previous CPU reading, the other half of a CPU percent delta. */
type CpuSample = { cpuUsage: number; systemTime: number };

/**
 * A caller-owned set of previous CPU readings. `getStats` replaces `samples`
 * at the end of each fast-path call, the same way it replaces its own field.
 */
export interface CpuSampleHolder {
    samples: Map<string, CpuSample>;
}

/** Bounds for `statsStream`'s interval, in milliseconds. */
export const STATS_STREAM_MIN_INTERVAL_MS = 1_000;
export const STATS_STREAM_MAX_INTERVAL_MS = 300_000;
export const STATS_STREAM_DEFAULT_INTERVAL_MS = 5_000;

/** restartCount/startedAt/imageSize/logSize for one container, refreshed at most once per `SLOW_CACHE_TTL_MS`. */
interface SlowCacheEntry {
    restartCount: number;
    startedAt: string;
    imageSize: number;
    logSize: number;
    cachedAt: number;
}

/**
 * Live container stats, ported from BOTH of `DockerClient`'s batch-stats
 * methods and the choice between them:
 *
 * - `fetchBatchStatsFast` (DockerClient.php:989-1149), which reads
 *   `/sys/fs/cgroup` and `/proc` directly — see `cgroup-stats.ts` for the
 *   reads themselves. `stats.php` calls this one, always.
 * - `fetchBatchStats` (DockerClient.php:1159-1240, `getStatsSlow` below),
 *   the Docker-API-based fallback `fetchBatchStatsFast` uses for any
 *   container (or the whole host) whose cgroup layout can't be detected.
 *
 * `getStats` reproduces that exact choice: detect a layout from one sample
 * id, and if none is found, hand the WHOLE batch to the slow path, exactly
 * as `if (!$layout) return $this->fetchBatchStats($ids);` does. Once a
 * layout is found, only the containers whose cgroup directory can't be read
 * fall back individually — `fetchBatchStatsFast`'s `$fallbackSet`.
 */
@Injectable()
export class ContainerStatsService {
    private readonly logger = new Logger(ContainerStatsService.name);

    /**
     * Detected once, from whichever id is first seen, then kept for the life
     * of this process. `undefined` = never attempted; `null` = attempted and
     * no cgroup layout was found. `DockerClient` does the same thing with a
     * static class property (`self::$cgroupLayoutDetected`/`$cgroupLayout`) —
     * a host's cgroup layout cannot change without a reboot, so "cache
     * forever" is correct in both languages. It is ALSO a faithful port of a
     * PHP quirk, not just its useful half: if the very first id this process
     * ever sees is unreadable (a bad id, or called before Docker starts),
     * `null` is cached forever too and every later call takes the slow path
     * for that reason alone. PHP has the identical limitation.
     */
    private cgroupLayout: CgroupLayout | null | undefined;

    /**
     * The previous CPU sample per container id, needed to compute a delta —
     * a single stats snapshot has no history of its own the way one Docker
     * `stats?stream=0` response does (it carries both `cpu_stats` and
     * `precpu_stats`).
     *
     * PHP keeps this in a JSON file (`CPU_SAMPLES_PATH`,
     * `/tmp/unraid-docker-stats-cpu.json`) because PHP-FPM holds nothing in
     * memory between requests — every request is a fresh process. This API is
     * one long-running process, so the natural place for "the last thing I
     * saw" is an instance field, not a file.
     *
     * Deliberately NOT the same file PHP writes, and not a file at all. Two
     * independent processes (this one and PHP-FPM, if both backends are ever
     * live at once) writing the same path with no locking between them WOULD
     * corrupt it: `saveJsonCache` writes to a temp file and renames over the
     * original, which is atomic for one writer, but two writers racing that
     * same sequence can still have B's rename land between A's read and A's
     * own write, silently losing B's sample and handing A back a stale
     * previous-CPU-usage value — a wrong CPU delta, not a crash, which is the
     * worse kind of corruption because nothing would ever surface it.
     *
     * Fully REPLACED (not merged) at the end of every fast-path call — see
     * `getStatsFast` — matching `saveJsonCache(CPU_SAMPLES_PATH, $newSamples)`,
     * which likewise only ever contains the current batch's ids.
     */
    private readonly cpuSamples: CpuSampleHolder = { samples: new Map() };

    /**
     * Unlike `cpuSamples`, this MERGES across calls rather than replacing —
     * `DockerClient`'s `SLOW_CACHE_PATH` does the same: it loads the whole
     * cache, updates only the ids past their TTL, and saves the whole thing
     * back. An id absent from a given batch keeps its last-known entry here
     * rather than losing it, and — also matching PHP — nothing ever prunes an
     * entry for a container that stops being asked about. That is a real,
     * if minor, unbounded-growth trait this shares with the PHP file; ported
     * faithfully rather than "fixed" into something PHP does not do.
     */
    private readonly slowCache = new Map<string, SlowCacheEntry>();

    /** `DockerClient::SLOW_CACHE_TTL` (60 seconds), in milliseconds. */
    private static readonly SLOW_CACHE_TTL_MS = 60_000;

    /** One shared reading loop per stream interval. See `statsStream`. */
    private readonly statsLoops = new Map<number, StatsLoop>();

    constructor(@Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerFoldersExtraDockerClient) {}

    /**
     * `sources` overrides `/sys/fs/cgroup` and `/proc` for tests, the same
     * `TemplateSources`-shaped contract `unraid-templates.ts` uses; the
     * resolver never passes one, so production always reads the real roots.
     */
    async getStats(
        ids: string[],
        sources: CgroupSources = {},
        cpuSamples: CpuSampleHolder = this.cpuSamples
    ): Promise<Map<string, DockerFoldersContainerStatsResult | null>> {
        if (ids.length === 0) return new Map();

        const layout = this.detectLayout(ids[0], sources);
        if (layout === null) {
            return this.getStatsSlow(ids);
        }

        return this.getStatsFast(ids, layout, sources, cpuSamples);
    }

    /**
     * `getStats` for `ids`, sent once at subscribe time and then every
     * `intervalMs`, until the subscriber goes away. This is what the stats
     * subscription serves in place of the browser polling the query.
     *
     * Every stream with the same interval shares one reading loop, which
     * reads the union of their ids and sends each stream its own part. The
     * cost therefore does not grow with the number of open tabs. A reading
     * is about 2.4 ms of CPU for 23 containers on the fast path.
     *
     * The loop keeps its own previous CPU readings, apart from the query
     * path's set. That set is replaced on every call and holds only that
     * call's ids, so two readers with different ids would erase each other's
     * readings and see 0% CPU. The query path keeps that PHP behavior.
     *
     * The next reading is scheduled only after the current one finishes, so a
     * slow reading (the Docker-API path takes a second or more per container)
     * delays the next one instead of overlapping it. A new stream asks for a
     * reading at once, so it does not wait up to a whole interval.
     */
    statsStream(
        ids: string[],
        intervalMs: number = STATS_STREAM_DEFAULT_INTERVAL_MS,
        sources: CgroupSources = {}
    ): Observable<Map<string, DockerFoldersContainerStatsResult | null>> {
        const interval = clampStatsInterval(intervalMs);

        return new Observable((subscriber) => {
            let loop = this.statsLoops.get(interval);
            if (loop === undefined) {
                loop = new StatsLoop(interval, (union, holder) => this.getStats(union, sources, holder), this.logger, () =>
                    this.statsLoops.delete(interval)
                );
                this.statsLoops.set(interval, loop);
            }

            const member: StatsLoopMember = { ids, send: (stats) => subscriber.next(stats) };
            loop.add(member);

            return () => {
                loop.remove(member);
                this.logger.debug(`Stats stream for ${ids.length} container(s) closed`);
            };
        });
    }

    private detectLayout(sampleId: string, sources: CgroupSources): CgroupLayout | null {
        if (this.cgroupLayout === undefined) {
            this.cgroupLayout = detectCgroupLayout(sampleId, sources);
        }
        return this.cgroupLayout;
    }

    private async getStatsFast(
        ids: string[],
        layout: CgroupLayout,
        sources: CgroupSources,
        cpuSamples: CpuSampleHolder
    ): Promise<Map<string, DockerFoldersContainerStatsResult | null>> {
        const systemCpu = readSystemCpuInfo(sources);

        const cgroupData = new Map<string, CgroupContainerStats>();
        const netData = new Map<string, { rx: number; tx: number }>();
        const fallbackIds = new Set<string>();

        for (const id of ids) {
            const cg = readCgroupContainerStats(id, layout, systemCpu, sources);
            if (cg === null) {
                fallbackIds.add(id);
                continue;
            }
            cgroupData.set(id, cg);
            netData.set(id, readNetworkStatsForContainer(id, layout, sources));
        }

        const previousSamples = cpuSamples.samples;
        const newSamples = new Map<string, CpuSample>();
        for (const [id, cg] of cgroupData) {
            newSamples.set(id, { cpuUsage: cg.cpuUsage, systemTime: cg.systemTime });
        }

        const staleIds = ids.filter((id) => !fallbackIds.has(id) && this.isSlowCacheStale(id));
        if (staleIds.length > 0) {
            await this.refreshSlowCache(staleIds);
        }

        // Read once per call, always — not only when a container's own limit
        // is unlimited — since every result now also reports it as `hostMemory`.
        const hostMemory = readSystemMemoryTotalBytes(sources);
        const output = new Map<string, DockerFoldersContainerStatsResult | null>();

        for (const id of ids) {
            if (fallbackIds.has(id)) continue;

            const cg = cgroupData.get(id);
            if (cg === undefined) continue;
            const net = netData.get(id) ?? { rx: 0, tx: 0 };
            const previous = previousSamples.get(id) ?? null;
            const slow = this.slowCache.get(id);

            const cpuPercent = previous
                ? cpuPercentFromDelta(cg.cpuUsage - previous.cpuUsage, cg.systemTime - previous.systemTime, cg.onlineCpus)
                : 0.0;

            const memoryLimit = cg.memoryLimit === MEMORY_UNLIMITED ? hostMemory : cg.memoryLimit;

            output.set(id, {
                cpuPercent,
                memoryUsage: cg.memoryUsage,
                memoryLimit,
                memoryPercent: memoryPercent(cg.memoryUsage, memoryLimit),
                blockRead: cg.ioRead,
                blockWrite: cg.ioWrite,
                netRx: net.rx,
                netTx: net.tx,
                pids: cg.pids,
                restartCount: slow?.restartCount ?? 0,
                startedAt: slow?.startedAt ?? '',
                imageSize: slow?.imageSize ?? 0,
                logSize: slow?.logSize ?? 0,
                hostCpus: cg.onlineCpus,
                hostMemory,
            });
        }

        // Full replace, not merge — see the doc comment on the field itself.
        cpuSamples.samples = newSamples;

        if (fallbackIds.size > 0) {
            const fallback = await this.getStatsSlow([...fallbackIds]);
            for (const [id, stats] of fallback) output.set(id, stats);
        }

        return output;
    }

    private isSlowCacheStale(id: string): boolean {
        const cached = this.slowCache.get(id);
        return cached === undefined || Date.now() - cached.cachedAt > ContainerStatsService.SLOW_CACHE_TTL_MS;
    }

    /**
     * Refresh `restartCount`/`startedAt`/`imageSize`/`logSize` for ids whose
     * cache entry is missing or stale, ported from the `$staleIds` block in
     * `fetchBatchStatsFast` (DockerClient.php:1023-1071): inspect every stale
     * id, then look up each DISTINCT image id it names, deduplicated exactly
     * as PHP's `$imageMap` does, so a ten-container stack sharing one image
     * only inspects that image once.
     */
    private async refreshSlowCache(staleIds: string[]): Promise<void> {
        const inspected = await Promise.all(
            staleIds.map(async (id): Promise<[string, DockerFoldersRawInspect | null]> => {
                try {
                    return [id, await this.docker.getContainer(id).inspect()];
                } catch (error) {
                    this.logger.warn(`Could not inspect container ${id} for stats: ${String(error)}`);
                    return [id, null];
                }
            })
        );

        const imageIds = new Set<string>();
        for (const [, inspect] of inspected) {
            const imageId = inspect?.Image ?? '';
            if (imageId !== '') imageIds.add(imageId);
        }

        const imageSizes = new Map<string, number>();
        await Promise.all(
            [...imageIds].map(async (imageId) => {
                try {
                    const image = await this.docker.getImage(imageId).inspect();
                    imageSizes.set(imageId, image.Size ?? 0);
                } catch (error) {
                    this.logger.warn(`Could not inspect image ${imageId}: ${String(error)}`);
                }
            })
        );

        const now = Date.now();
        for (const [id, inspect] of inspected) {
            if (inspect === null) continue;

            const imageId = inspect.Image ?? '';
            this.slowCache.set(id, {
                restartCount: inspect.RestartCount ?? 0,
                startedAt: inspect.State?.StartedAt ?? '',
                imageSize: imageId !== '' ? imageSizes.get(imageId) ?? 0 : 0,
                logSize: containerLogSize(inspect.Id, id),
                cachedAt: now,
            });
        }
    }

    /**
     * `GET /containers/{id}/stats?stream=0`, ported from
     * `DockerClient::fetchBatchStats` (DockerClient.php:1159-1240) — the
     * fallback path, reached when no cgroup layout was found for the batch,
     * or per-container for one whose cgroup directory could not be read.
     *
     * Fetched in parallel across ids with `Promise.all`, the `curl_multi`
     * equivalent: `stats({stream: false})` blocks roughly a second per
     * container (Docker samples CPU usage twice to compute a delta), so doing
     * this sequentially would make a 10-container fallback take 10 seconds.
     */
    private async getStatsSlow(ids: string[]): Promise<Map<string, DockerFoldersContainerStatsResult | null>> {
        const entries = await Promise.all(ids.map((id) => this.getOneSlow(id)));
        return new Map(entries);
    }

    private async getOneSlow(id: string): Promise<[string, DockerFoldersContainerStatsResult | null]> {
        let stats;
        try {
            stats = await this.docker.getContainer(id).stats({ stream: false });
        } catch (error) {
            this.logger.warn(`Could not read stats for container ${id}: ${String(error)}`);
            return [id, null];
        }
        if (!stats) return [id, null];

        let inspect: DockerFoldersRawInspect | null = null;
        try {
            inspect = await this.docker.getContainer(id).inspect();
        } catch (error) {
            // A container that vanishes between the stats call and the
            // inspect call (stopped and removed mid-refresh) still reports
            // its stats sample; restartCount/startedAt just default out.
            this.logger.warn(`Could not inspect container ${id} for stats: ${String(error)}`);
        }

        let imageSize = 0;
        const imageId = inspect?.Image ?? '';
        if (imageId !== '') {
            try {
                const image = await this.docker.getImage(imageId).inspect();
                imageSize = image.Size ?? 0;
            } catch (error) {
                this.logger.warn(`Could not inspect image ${imageId}: ${String(error)}`);
            }
        }

        const logSize = containerLogSize(stats.id, id);
        const hostMemory = readSystemMemoryTotalBytes();

        return [id, buildContainerStats(stats, inspect, imageSize, logSize, hostMemory)];
    }
}

/** `intervalMs` from a subscription argument, bounded, with the default for anything that is not a number. */
export function clampStatsInterval(intervalMs: number | null | undefined): number {
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) return STATS_STREAM_DEFAULT_INTERVAL_MS;
    return Math.min(STATS_STREAM_MAX_INTERVAL_MS, Math.max(STATS_STREAM_MIN_INTERVAL_MS, Math.round(intervalMs)));
}

interface StatsLoopMember {
    ids: string[];
    send: (stats: Map<string, DockerFoldersContainerStatsResult | null>) => void;
}

/**
 * One reading loop shared by every stats stream with the same interval. It
 * runs while it has members and stops, and removes itself, when the last
 * member leaves.
 */
class StatsLoop {
    private readonly members = new Set<StatsLoopMember>();
    private readonly cpuSamples: CpuSampleHolder = { samples: new Map() };
    private timer: ReturnType<typeof setTimeout> | null = null;
    private reading = false;
    /** A member joined during a reading, so read again as soon as it ends. */
    private readAgain = false;

    constructor(
        private readonly interval: number,
        private readonly read: (
            ids: string[],
            holder: CpuSampleHolder
        ) => Promise<Map<string, DockerFoldersContainerStatsResult | null>>,
        private readonly logger: Logger,
        private readonly onEmpty: () => void
    ) {}

    add(member: StatsLoopMember): void {
        this.members.add(member);
        this.readSoon();
    }

    remove(member: StatsLoopMember): void {
        this.members.delete(member);
        if (this.members.size > 0) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.onEmpty();
    }

    private readSoon(): void {
        if (this.reading) {
            this.readAgain = true;
            return;
        }
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.tick(), 0);
    }

    private async tick(): Promise<void> {
        this.timer = null;
        if (this.members.size === 0) return;

        this.reading = true;
        const members = [...this.members];
        const union = [...new Set(members.flatMap((member) => member.ids))];
        try {
            const stats = await this.read(union, this.cpuSamples);
            for (const member of members) {
                // A member that left during the reading gets nothing.
                if (!this.members.has(member)) continue;
                member.send(new Map(member.ids.map((id) => [id, stats.get(id) ?? null])));
            }
        } catch (error) {
            // One failed reading must not end a stream that the next reading
            // would recover. The query path reports nothing for a failed
            // reading either.
            this.logger.warn(`Stats stream reading failed: ${String(error)}`);
        }
        this.reading = false;

        if (this.members.size === 0) return;
        if (this.readAgain) {
            this.readAgain = false;
            this.timer = setTimeout(() => void this.tick(), 0);
            return;
        }
        this.timer = setTimeout(() => void this.tick(), this.interval);
    }
}
