import { describe, it, expect } from 'vitest';
import { aggregateStats } from '../aggregateStats';
import type { ContainerStats } from '@/stores/stats';

const GB = 1024 ** 3;

function stats(over: Partial<ContainerStats>): ContainerStats {
  return {
    cpuPercent: 0,
    memoryUsage: 0,
    memoryLimit: 16 * GB,
    memoryPercent: 0,
    blockRead: 0,
    blockWrite: 0,
    netRx: 0,
    netTx: 0,
    pids: 1,
    restartCount: 0,
    startedAt: '',
    imageSize: 0,
    logSize: 0,
    hostCpus: 4,
    hostMemory: 16 * GB,
    ...over,
  };
}

describe('aggregateStats', () => {
  it('returns null for no containers', () => {
    expect(aggregateStats([])).toBeNull();
  });

  it('sums CPU and divides by the host core count, not the member count', () => {
    const r = aggregateStats([stats({ cpuPercent: 200 }), stats({ cpuPercent: 0 }), stats({ cpuPercent: 0 })]);
    expect(r?.cpuPercent).toBe(50);
    expect(r?.count).toBe(3);
  });

  it('measures memory against host memory, even when a container has its own limit', () => {
    const r = aggregateStats([
      stats({ memoryUsage: 2 * GB, memoryLimit: 2 * GB, memoryPercent: 100 }),
      stats({ memoryUsage: 2 * GB }),
    ]);
    expect(r?.memPercent).toBe(25);
    expect(r?.memoryUsage).toBe(4 * GB);
  });

  it('falls back to the Docker-scale sum and the largest limit without host fields', () => {
    const r = aggregateStats([
      stats({ cpuPercent: 30, memoryUsage: 1 * GB, memoryLimit: 8 * GB, hostCpus: undefined, hostMemory: undefined }),
      stats({ cpuPercent: 20, memoryUsage: 1 * GB, memoryLimit: 2 * GB, hostCpus: undefined, hostMemory: undefined }),
    ]);
    expect(r?.cpuPercent).toBe(50);
    expect(r?.memPercent).toBe(25);
  });
});
