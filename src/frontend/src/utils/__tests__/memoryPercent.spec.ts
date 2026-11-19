import { describe, it, expect } from 'vitest';
import { makeContainerStats } from '@/test/fixtures';
import { memoryDetailText, memoryPercentView, parseMemoryPercentBasis } from '../memoryPercent';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** The report in issue 29: `--memory 4g` on a 32 GB host, 952.4 MB used. */
const capped = () =>
  makeContainerStats({
    memoryUsage: 952.4 * MB,
    memoryLimit: 4 * GB,
    memoryPercent: 23.25,
    hostMemory: 32 * GB,
  });

/** No `--memory`: Docker reports the host total as the limit. */
const uncapped = () =>
  makeContainerStats({
    memoryUsage: 952.4 * MB,
    memoryLimit: 32 * GB,
    memoryPercent: 2.91,
    hostMemory: 32 * GB,
  });

describe('parseMemoryPercentBasis', () => {
  it('reads host, and falls back to limit for anything else', () => {
    expect(parseMemoryPercentBasis('host')).toBe('host');
    expect(parseMemoryPercentBasis('limit')).toBe('limit');
    expect(parseMemoryPercentBasis('')).toBe('limit');
    expect(parseMemoryPercentBasis(undefined)).toBe('limit');
    expect(parseMemoryPercentBasis('total')).toBe('limit');
  });
});

describe('memoryPercentView', () => {
  describe('limit basis', () => {
    it('shows the backend percent of a capped container, labelled of limit', () => {
      const view = memoryPercentView(capped(), 'limit');
      expect(view.percent).toBe(23.25);
      expect(view.level).toBe(23.25);
      expect(view.basis).toBe('limit');
      expect(view.capped).toBe(true);
      expect(view.suffix).toBe('of limit');
      expect(view.title).toBe('952.4 MB of the 4.0 GB container limit.');
    });

    it('calls an uncapped container what it is: the host is its limit', () => {
      const view = memoryPercentView(uncapped(), 'limit');
      expect(view.percent).toBe(2.91);
      expect(view.capped).toBe(false);
      expect(view.suffix).toBe('of host');
      expect(view.title).toContain('No container limit is set');
      expect(view.title).toContain('32.0 GB host memory');
    });

    it('treats a limit as capped when host memory is unknown', () => {
      const view = memoryPercentView(
        makeContainerStats({ memoryUsage: GB, memoryLimit: 4 * GB, memoryPercent: 25, hostMemory: undefined }),
        'limit',
      );
      expect(view.capped).toBe(true);
      expect(view.suffix).toBe('of limit');
    });
  });

  describe('host basis', () => {
    it('divides usage by host memory for a capped container', () => {
      const view = memoryPercentView(capped(), 'host');
      expect(view.percent).toBeCloseTo(2.906, 2);
      expect(view.basis).toBe('host');
      expect(view.suffix).toBe('of host');
      expect(view.title).toContain('952.4 MB of 32.0 GB host memory');
      expect(view.title).toContain('container limit is 4.0 GB');
    });

    it('gives an uncapped container the same percent on either basis', () => {
      const host = memoryPercentView(uncapped(), 'host');
      const limit = memoryPercentView(uncapped(), 'limit');
      expect(host.percent).toBeCloseTo(limit.percent, 1);
      expect(host.title).toContain('No container limit is set');
    });

    it('keeps the bar color on the limit for a capped container, so a near-OOM state is not hidden', () => {
      const view = memoryPercentView(
        makeContainerStats({ memoryUsage: 3.8 * GB, memoryLimit: 4 * GB, memoryPercent: 95, hostMemory: 32 * GB }),
        'host',
      );
      expect(view.percent).toBeCloseTo(11.9, 1);
      expect(view.level).toBe(95);
    });

    it('lets the shown percent drive the color of an uncapped container', () => {
      const view = memoryPercentView(
        makeContainerStats({ memoryUsage: 30 * GB, memoryLimit: 32 * GB, memoryPercent: 93.75, hostMemory: 32 * GB }),
        'host',
      );
      expect(view.level).toBeCloseTo(93.75, 2);
    });

    it('falls back to the limit, and says so, when host memory is missing', () => {
      for (const hostMemory of [undefined, 0]) {
        const view = memoryPercentView(
          makeContainerStats({ memoryUsage: GB, memoryLimit: 4 * GB, memoryPercent: 25, hostMemory }),
          'host',
        );
        expect(view.basis).toBe('limit');
        expect(view.percent).toBe(25);
        expect(view.suffix).toBe('of limit');
        expect(view.title).toContain('Host memory is not known');
      }
    });
  });
});

describe('memoryDetailText', () => {
  it('keeps the real limit in the text and names the basis', () => {
    expect(memoryDetailText(capped(), memoryPercentView(capped(), 'limit'))).toBe('952.4 MB / 4.0 GB (23.3% of limit)');
    expect(memoryDetailText(capped(), memoryPercentView(capped(), 'host'))).toBe('952.4 MB / 4.0 GB (2.9% of host)');
  });
});
