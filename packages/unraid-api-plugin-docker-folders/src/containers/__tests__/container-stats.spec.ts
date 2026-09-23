import { describe, expect, it } from 'vitest';

import {
    buildContainerStats,
    calculateBlockIO,
    calculateCpuPercent,
    calculateMemoryStats,
    calculateNetworkIO,
    calculatePids,
} from '../container-stats.js';
import type { DockerFoldersRawInspect, DockerFoldersRawStats } from '../extras-docker-client.js';

/**
 * A line-for-line translation of `tests/php/DockerClientStatsTest.php`'s
 * fixtures and assertions. Parity with the PHP is the goal, so test names and
 * structure mirror the source file rather than being reorganised.
 */
describe('calculateCpuPercent', () => {
    it('normal usage', () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: {
                cpu_usage: { total_usage: 200000000 },
                system_cpu_usage: 1000000000,
                online_cpus: 4,
            },
            precpu_stats: {
                cpu_usage: { total_usage: 100000000 },
                system_cpu_usage: 500000000,
            },
        };

        // cpuDelta = 200M - 100M = 100M
        // systemDelta = 1000M - 500M = 500M
        // (100M / 500M) * 4 * 100 = 80.0
        expect(calculateCpuPercent(stats)).toBe(80.0);
    });

    it('zero system delta returns zero', () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500, online_cpus: 2 },
            precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
        };

        expect(calculateCpuPercent(stats)).toBe(0.0);
    });

    it('missing fields returns zero', () => {
        expect(calculateCpuPercent({})).toBe(0.0);
    });

    it('single cpu', () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: { cpu_usage: { total_usage: 50000 }, system_cpu_usage: 200000, online_cpus: 1 },
            precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        };

        // (50000 / 200000) * 1 * 100 = 25.0
        expect(calculateCpuPercent(stats)).toBe(25.0);
    });

    it('defaults online_cpus to 1', () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: { cpu_usage: { total_usage: 50000 }, system_cpu_usage: 200000 },
            precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        };

        expect(calculateCpuPercent(stats)).toBe(25.0);
    });

    it('rounds to two decimals', () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 30000, online_cpus: 1 },
            precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
        };

        // (1000 / 30000) * 1 * 100 = 3.333... -> 3.33
        expect(calculateCpuPercent(stats)).toBe(3.33);
    });
});

describe('calculateMemoryStats', () => {
    it('normal usage', () => {
        const stats: DockerFoldersRawStats = {
            memory_stats: { usage: 524288000, limit: 1073741824 },
        };

        const result = calculateMemoryStats(stats);

        expect(result.usage).toBe(524288000);
        expect(result.limit).toBe(1073741824);
        expect(result.percent).toBe(48.83);
    });

    it('missing fields', () => {
        const result = calculateMemoryStats({});

        expect(result.usage).toBe(0);
        expect(result.limit).toBe(1);
        expect(result.percent).toBe(0.0);
    });

    it('zero limit returns zero percent', () => {
        const result = calculateMemoryStats({ memory_stats: { usage: 100, limit: 0 } });

        expect(result.percent).toBe(0);
    });

    it('full usage', () => {
        const result = calculateMemoryStats({ memory_stats: { usage: 1000, limit: 1000 } });

        expect(result.percent).toBe(100.0);
    });
});

describe('calculateBlockIO', () => {
    it('sums read and write', () => {
        const stats: DockerFoldersRawStats = {
            blkio_stats: {
                io_service_bytes_recursive: [
                    { op: 'Read', value: 1024 },
                    { op: 'Write', value: 2048 },
                    { op: 'Read', value: 512 },
                    { op: 'Write', value: 256 },
                ],
            },
        };

        const result = calculateBlockIO(stats);
        expect(result.read).toBe(1536);
        expect(result.write).toBe(2304);
    });

    it('missing fields', () => {
        const result = calculateBlockIO({});
        expect(result.read).toBe(0);
        expect(result.write).toBe(0);
    });

    it('ignores non read/write ops', () => {
        const stats: DockerFoldersRawStats = {
            blkio_stats: {
                io_service_bytes_recursive: [
                    { op: 'Read', value: 100 },
                    { op: 'Sync', value: 999 },
                    { op: 'Async', value: 888 },
                    { op: 'Write', value: 200 },
                ],
            },
        };

        const result = calculateBlockIO(stats);
        expect(result.read).toBe(100);
        expect(result.write).toBe(200);
    });

    it('handles case-insensitive ops', () => {
        const stats: DockerFoldersRawStats = {
            blkio_stats: {
                io_service_bytes_recursive: [
                    { op: 'READ', value: 100 },
                    { op: 'WRITE', value: 200 },
                    { op: 'read', value: 50 },
                    { op: 'write', value: 75 },
                ],
            },
        };

        const result = calculateBlockIO(stats);
        expect(result.read).toBe(150);
        expect(result.write).toBe(275);
    });

    it('handles null recursive array', () => {
        const result = calculateBlockIO({ blkio_stats: { io_service_bytes_recursive: null } });
        expect(result.read).toBe(0);
        expect(result.write).toBe(0);
    });
});

describe('calculateNetworkIO', () => {
    it('sums across interfaces', () => {
        const stats: DockerFoldersRawStats = {
            networks: {
                eth0: { rx_bytes: 1000, tx_bytes: 2000 },
                eth1: { rx_bytes: 500, tx_bytes: 300 },
            },
        };

        const result = calculateNetworkIO(stats);
        expect(result.rx).toBe(1500);
        expect(result.tx).toBe(2300);
    });

    it('missing fields', () => {
        const result = calculateNetworkIO({});
        expect(result.rx).toBe(0);
        expect(result.tx).toBe(0);
    });

    it('single interface', () => {
        const result = calculateNetworkIO({ networks: { eth0: { rx_bytes: 12345, tx_bytes: 67890 } } });
        expect(result.rx).toBe(12345);
        expect(result.tx).toBe(67890);
    });

    it('handles missing bytes fields', () => {
        const result = calculateNetworkIO({ networks: { eth0: {}, eth1: { rx_bytes: 100 } } });
        expect(result.rx).toBe(100);
        expect(result.tx).toBe(0);
    });
});

describe('calculatePids', () => {
    it('returns current count', () => {
        expect(calculatePids({ pids_stats: { current: 42 } })).toBe(42);
    });

    it('missing fields returns zero', () => {
        expect(calculatePids({})).toBe(0);
    });

    it('missing current returns zero', () => {
        expect(calculatePids({ pids_stats: {} })).toBe(0);
    });
});

describe('buildContainerStats', () => {
    it('assembles the frontend-shaped result from stats, inspect, image size, and log size', () => {
        const stats: DockerFoldersRawStats = {
            cpu_stats: { cpu_usage: { total_usage: 200000000 }, system_cpu_usage: 1000000000, online_cpus: 4 },
            precpu_stats: { cpu_usage: { total_usage: 100000000 }, system_cpu_usage: 500000000 },
            memory_stats: { usage: 524288000, limit: 1073741824 },
            blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 10 }, { op: 'Write', value: 20 }] },
            networks: { eth0: { rx_bytes: 1, tx_bytes: 2 } },
            pids_stats: { current: 7 },
        };
        const inspect: DockerFoldersRawInspect = {
            RestartCount: 3,
            State: { StartedAt: '2024-01-01T00:00:00Z' },
        };

        const result = buildContainerStats(stats, inspect, 12345, 6789);

        expect(result).toEqual({
            cpuPercent: 80.0,
            memoryUsage: 524288000,
            memoryLimit: 1073741824,
            memoryPercent: 48.83,
            blockRead: 10,
            blockWrite: 20,
            netRx: 1,
            netTx: 2,
            pids: 7,
            restartCount: 3,
            startedAt: '2024-01-01T00:00:00Z',
            imageSize: 12345,
            logSize: 6789,
        });
    });

    it('defaults restartCount and startedAt when inspect is unavailable', () => {
        const result = buildContainerStats({}, null, 0, 0);

        expect(result.restartCount).toBe(0);
        expect(result.startedAt).toBe('');
    });
});
