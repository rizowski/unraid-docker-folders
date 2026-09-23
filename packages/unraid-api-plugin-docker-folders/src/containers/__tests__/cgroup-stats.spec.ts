import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DOCKER_CONTAINER_ID_PATTERN,
    MEMORY_UNLIMITED,
    detectCgroupLayout,
    parseCgroupV1BlkioThrottle,
    parseCgroupV1CpuUsageNs,
    parseCgroupV1MemoryLimit,
    parseCgroupV2CpuUsageNs,
    parseCgroupV2IoStat,
    parseCgroupV2MemoryMax,
    parseFirstPid,
    parseMemInfoTotalBytes,
    parseMemoryCurrent,
    parseNetDevCounters,
    parseOnlineCpuCount,
    parsePidsCurrent,
    parseProcStatSystemTimeNs,
    readCgroupContainerStats,
    readNetworkStatsForContainer,
    readSystemCpuInfo,
    readSystemMemoryTotalBytes,
    type CgroupSources,
} from '../cgroup-stats.js';

const FULL_ID = 'a'.repeat(64);

describe('DOCKER_CONTAINER_ID_PATTERN', () => {
    it('accepts full and short hex ids', () => {
        expect(DOCKER_CONTAINER_ID_PATTERN.test('a'.repeat(64))).toBe(true);
        expect(DOCKER_CONTAINER_ID_PATTERN.test('deadbeefcafe')).toBe(true);
    });

    it('rejects anything that is not lowercase hex, or too short', () => {
        expect(DOCKER_CONTAINER_ID_PATTERN.test('../../etc/passwd')).toBe(false);
        expect(DOCKER_CONTAINER_ID_PATTERN.test('DEADBEEFCAFE')).toBe(false);
        expect(DOCKER_CONTAINER_ID_PATTERN.test('abc')).toBe(false);
    });
});

// ─── pure text parsing ──────────────────────────────────────────────

describe('parseCgroupV2CpuUsageNs', () => {
    it('converts usage_usec (microseconds) to nanoseconds', () => {
        expect(parseCgroupV2CpuUsageNs('usage_usec 1000\nuser_usec 500\nsystem_usec 500\n')).toBe(1_000_000);
    });

    it('is null when the line is missing', () => {
        expect(parseCgroupV2CpuUsageNs('nothing here')).toBeNull();
    });
});

describe('parseCgroupV1CpuUsageNs', () => {
    it('parses the raw nanosecond value', () => {
        expect(parseCgroupV1CpuUsageNs('123456789\n')).toBe(123456789);
    });
});

describe('parseMemoryCurrent / parseCgroupV2MemoryMax', () => {
    it('parses a byte count', () => {
        expect(parseMemoryCurrent('524288000\n')).toBe(524288000);
    });

    it('treats "max" as unlimited', () => {
        expect(parseCgroupV2MemoryMax('max\n')).toBe(MEMORY_UNLIMITED);
    });

    it('parses a real limit', () => {
        expect(parseCgroupV2MemoryMax('1073741824\n')).toBe(1073741824);
    });
});

describe('parseCgroupV1MemoryLimit', () => {
    it('treats a number past 1e17 as unlimited', () => {
        expect(parseCgroupV1MemoryLimit('9223372036854771712\n')).toBe(MEMORY_UNLIMITED);
    });

    it('parses a real limit under the threshold', () => {
        expect(parseCgroupV1MemoryLimit('1073741824\n')).toBe(1073741824);
    });
});

describe('parseCgroupV2IoStat', () => {
    it('sums rbytes/wbytes across every device line', () => {
        const text = '8:0 rbytes=1024 wbytes=2048 rios=1 wios=1\n8:16 rbytes=512 wbytes=256 rios=1 wios=1\n';
        expect(parseCgroupV2IoStat(text)).toEqual({ read: 1536, write: 2304 });
    });

    it('handles an empty stat file', () => {
        expect(parseCgroupV2IoStat('')).toEqual({ read: 0, write: 0 });
    });
});

describe('parseCgroupV1BlkioThrottle', () => {
    it('sums Read/Write lines case-insensitively, ignoring Total', () => {
        const text = '8:0 Read 1024\n8:0 Write 2048\n8:0 Total 3072\n8:16 read 512\n8:16 write 256\n';
        expect(parseCgroupV1BlkioThrottle(text)).toEqual({ read: 1536, write: 2304 });
    });
});

describe('parsePidsCurrent', () => {
    it('parses the count', () => {
        expect(parsePidsCurrent('7\n')).toBe(7);
    });
});

describe('parseProcStatSystemTimeNs', () => {
    it('sums jiffy fields on the cpu line and converts to nanoseconds', () => {
        // user=1 nice=1 system=1 idle=1 -> total 4 jiffies * 1e7 ns/jiffy
        const text = 'cpu  1 1 1 1 0 0 0 0 0 0\ncpu0 1 0 0 0 0 0 0 0 0 0\n';
        expect(parseProcStatSystemTimeNs(text)).toBe(4 * 10_000_000);
    });

    it('returns 0 for a malformed line', () => {
        expect(parseProcStatSystemTimeNs('cpu\n')).toBe(0);
    });
});

describe('parseOnlineCpuCount', () => {
    it('counts per-cpu lines', () => {
        const text = 'cpu  1 2 3 4\ncpu0 1 2 3 4\ncpu1 1 2 3 4\ncpu2 1 2 3 4\ncpu3 1 2 3 4\nintr 123\n';
        expect(parseOnlineCpuCount(text)).toBe(4);
    });

    it('defaults to 1 when no per-cpu lines are present', () => {
        expect(parseOnlineCpuCount('cpu  1 2 3 4\n')).toBe(1);
    });
});

describe('parseNetDevCounters', () => {
    it('sums rx (field 0) and tx (field 8), excluding lo', () => {
        const text =
            'Inter-|   Receive                                                |  Transmit\n' +
            ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n' +
            '    lo: 999999       1    0    0    0     0          0         0   999999       1    0    0    0     0       0          0\n' +
            '  eth0: 1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0\n';

        expect(parseNetDevCounters(text)).toEqual({ rx: 1000, tx: 2000 });
    });
});

describe('parseFirstPid', () => {
    it('parses the first pid', () => {
        expect(parseFirstPid('4242\n5000\n')).toBe(4242);
    });

    it('is null for an empty or non-positive value', () => {
        expect(parseFirstPid('')).toBeNull();
        expect(parseFirstPid('0\n')).toBeNull();
    });
});

describe('parseMemInfoTotalBytes', () => {
    it('converts MemTotal from kB to bytes', () => {
        expect(parseMemInfoTotalBytes('MemTotal:       16384000 kB\nMemFree: 1000 kB\n')).toBe(16384000 * 1024);
    });

    it('is 0 when MemTotal is missing', () => {
        expect(parseMemInfoTotalBytes('nothing here')).toBe(0);
    });
});

// ─── filesystem reads, root injectable ──────────────────────────────

describe('cgroup filesystem reads', () => {
    let dir: string;
    let cgroupRoot: string;
    let procRoot: string;
    let sources: CgroupSources;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cgroup-stats-'));
        cgroupRoot = join(dir, 'sys-fs-cgroup');
        procRoot = join(dir, 'proc');
        mkdirSync(cgroupRoot, { recursive: true });
        mkdirSync(procRoot, { recursive: true });
        sources = { cgroupRoot, procRoot };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    describe('detectCgroupLayout', () => {
        it('detects v2-flat', () => {
            mkdirSync(join(cgroupRoot, 'docker', FULL_ID), { recursive: true });
            expect(detectCgroupLayout(FULL_ID, sources)).toBe('v2-flat');
        });

        it('detects v2-systemd', () => {
            mkdirSync(join(cgroupRoot, 'system.slice', `docker-${FULL_ID}.scope`), { recursive: true });
            expect(detectCgroupLayout(FULL_ID, sources)).toBe('v2-systemd');
        });

        it('detects v1', () => {
            mkdirSync(join(cgroupRoot, 'cpu', 'docker', FULL_ID), { recursive: true });
            expect(detectCgroupLayout(FULL_ID, sources)).toBe('v1');
        });

        it('is null when no layout matches', () => {
            expect(detectCgroupLayout(FULL_ID, sources)).toBeNull();
        });

        it('refuses to build a path for an id that is not a plausible Docker id', () => {
            // No fixture needed: DOCKER_CONTAINER_ID_PATTERN rejects this before
            // any path is built or any directory is probed.
            expect(detectCgroupLayout('../evil', sources)).toBeNull();
        });
    });

    describe('readSystemCpuInfo', () => {
        it('reads jiffies and cpu count from /proc/stat', () => {
            writeFileSync(join(procRoot, 'stat'), 'cpu  1 1 1 1\ncpu0 1 1 1 1\ncpu1 1 1 1 1\n', 'utf8');

            const result = readSystemCpuInfo(sources);
            expect(result.systemTime).toBe(4 * 10_000_000);
            expect(result.onlineCpus).toBe(2);
        });

        it('defaults when /proc/stat is unreadable', () => {
            expect(readSystemCpuInfo(sources)).toEqual({ systemTime: 0, onlineCpus: 1 });
        });
    });

    describe('readCgroupContainerStats (v2-flat)', () => {
        function containerDir() {
            const d = join(cgroupRoot, 'docker', FULL_ID);
            mkdirSync(d, { recursive: true });
            return d;
        }

        it('reads every counter file', () => {
            const d = containerDir();
            writeFileSync(join(d, 'cpu.stat'), 'usage_usec 2000000\n', 'utf8');
            writeFileSync(join(d, 'memory.current'), '104857600\n', 'utf8');
            writeFileSync(join(d, 'memory.max'), '1073741824\n', 'utf8');
            writeFileSync(join(d, 'io.stat'), '8:0 rbytes=1024 wbytes=2048\n', 'utf8');
            writeFileSync(join(d, 'pids.current'), '5\n', 'utf8');

            const result = readCgroupContainerStats(FULL_ID, 'v2-flat', { systemTime: 1000, onlineCpus: 4 }, sources);

            expect(result).toEqual({
                cpuUsage: 2_000_000_000,
                systemTime: 1000,
                onlineCpus: 4,
                memoryUsage: 104857600,
                memoryLimit: 1073741824,
                ioRead: 1024,
                ioWrite: 2048,
                pids: 5,
            });
        });

        it('defaults missing files to 0 rather than throwing', () => {
            containerDir();
            const result = readCgroupContainerStats(FULL_ID, 'v2-flat', { systemTime: 0, onlineCpus: 1 }, sources);
            expect(result).toEqual({
                cpuUsage: 0,
                systemTime: 0,
                onlineCpus: 1,
                memoryUsage: 0,
                memoryLimit: 0,
                ioRead: 0,
                ioWrite: 0,
                pids: 0,
            });
        });

        it('is null when the cgroup directory does not exist', () => {
            expect(readCgroupContainerStats(FULL_ID, 'v2-flat', { systemTime: 0, onlineCpus: 1 }, sources)).toBeNull();
        });

        it('is null for an id that does not look like a Docker id, before touching any path', () => {
            expect(readCgroupContainerStats('../evil', 'v2-flat', { systemTime: 0, onlineCpus: 1 }, sources)).toBeNull();
        });

        it('reports memory.max=max as MEMORY_UNLIMITED', () => {
            const d = containerDir();
            writeFileSync(join(d, 'memory.max'), 'max\n', 'utf8');

            const result = readCgroupContainerStats(FULL_ID, 'v2-flat', { systemTime: 0, onlineCpus: 1 }, sources);
            expect(result?.memoryLimit).toBe(MEMORY_UNLIMITED);
        });
    });

    describe('readCgroupContainerStats (v1)', () => {
        it('reads every subsystem file from its own directory', () => {
            mkdirSync(join(cgroupRoot, 'cpuacct', 'docker', FULL_ID), { recursive: true });
            mkdirSync(join(cgroupRoot, 'memory', 'docker', FULL_ID), { recursive: true });
            mkdirSync(join(cgroupRoot, 'blkio', 'docker', FULL_ID), { recursive: true });
            mkdirSync(join(cgroupRoot, 'pids', 'docker', FULL_ID), { recursive: true });

            writeFileSync(join(cgroupRoot, 'cpuacct', 'docker', FULL_ID, 'cpuacct.usage'), '3000000000\n', 'utf8');
            writeFileSync(
                join(cgroupRoot, 'memory', 'docker', FULL_ID, 'memory.usage_in_bytes'),
                '52428800\n',
                'utf8'
            );
            writeFileSync(
                join(cgroupRoot, 'memory', 'docker', FULL_ID, 'memory.limit_in_bytes'),
                '9223372036854771712\n',
                'utf8'
            );
            writeFileSync(
                join(cgroupRoot, 'blkio', 'docker', FULL_ID, 'blkio.throttle.io_service_bytes'),
                '8:0 Read 100\n8:0 Write 200\n8:0 Total 300\n',
                'utf8'
            );
            writeFileSync(join(cgroupRoot, 'pids', 'docker', FULL_ID, 'pids.current'), '3\n', 'utf8');

            const result = readCgroupContainerStats(FULL_ID, 'v1', { systemTime: 500, onlineCpus: 2 }, sources);

            expect(result).toEqual({
                cpuUsage: 3000000000,
                systemTime: 500,
                onlineCpus: 2,
                memoryUsage: 52428800,
                memoryLimit: MEMORY_UNLIMITED,
                ioRead: 100,
                ioWrite: 200,
                pids: 3,
            });
        });

        it('never returns null, even when nothing exists (defaults every field)', () => {
            const result = readCgroupContainerStats(FULL_ID, 'v1', { systemTime: 0, onlineCpus: 1 }, sources);
            expect(result).not.toBeNull();
            expect(result?.cpuUsage).toBe(0);
        });
    });

    describe('readNetworkStatsForContainer', () => {
        it('reads the first cgroup.procs pid and sums /proc/{pid}/net/dev', () => {
            const containerDir = join(cgroupRoot, 'docker', FULL_ID);
            mkdirSync(containerDir, { recursive: true });
            writeFileSync(join(containerDir, 'cgroup.procs'), '4242\n', 'utf8');

            mkdirSync(join(procRoot, '4242', 'net'), { recursive: true });
            writeFileSync(
                join(procRoot, '4242', 'net', 'dev'),
                '  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n',
                'utf8'
            );

            expect(readNetworkStatsForContainer(FULL_ID, 'v2-flat', sources)).toEqual({ rx: 1000, tx: 2000 });
        });

        it('reads from the pids subsystem directory on v1', () => {
            const pidsDir = join(cgroupRoot, 'pids', 'docker', FULL_ID);
            mkdirSync(pidsDir, { recursive: true });
            writeFileSync(join(pidsDir, 'cgroup.procs'), '55\n', 'utf8');

            mkdirSync(join(procRoot, '55', 'net'), { recursive: true });
            writeFileSync(join(procRoot, '55', 'net', 'dev'), '  eth0: 5 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0\n', 'utf8');

            expect(readNetworkStatsForContainer(FULL_ID, 'v1', sources)).toEqual({ rx: 5, tx: 6 });
        });

        it('is {rx:0,tx:0} when cgroup.procs is empty', () => {
            mkdirSync(join(cgroupRoot, 'docker', FULL_ID), { recursive: true });
            writeFileSync(join(cgroupRoot, 'docker', FULL_ID, 'cgroup.procs'), '', 'utf8');

            expect(readNetworkStatsForContainer(FULL_ID, 'v2-flat', sources)).toEqual({ rx: 0, tx: 0 });
        });

        it('refuses an id that does not look like a Docker id', () => {
            expect(readNetworkStatsForContainer('../evil', 'v2-flat', sources)).toEqual({ rx: 0, tx: 0 });
        });
    });

    describe('readSystemMemoryTotalBytes', () => {
        it('reads MemTotal from /proc/meminfo', () => {
            writeFileSync(join(procRoot, 'meminfo'), 'MemTotal:       8000000 kB\n', 'utf8');
            expect(readSystemMemoryTotalBytes(sources)).toBe(8000000 * 1024);
        });

        it('is 0 when /proc/meminfo is unreadable', () => {
            expect(readSystemMemoryTotalBytes(sources)).toBe(0);
        });
    });
});
