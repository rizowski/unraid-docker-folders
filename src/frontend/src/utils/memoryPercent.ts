/**
 * What a container's memory percent is based on, and how to say so.
 *
 * Backends report `memoryPercent` as usage over the container's limit, as
 * `docker stats` does. A container with no limit has the host's total memory
 * as its limit, so for it the two bases give the same number. The
 * `memory_percent_basis` setting picks `limit` (the default) or `host`.
 *
 * The percent decides the bar width and the label. The bar color follows
 * `level`, which stays on the container's own limit even on the host basis: a
 * container at 95% of its cap is close to an OOM kill, however small a share of
 * the host that is.
 */

import type { ContainerStats } from '@/stores/stats';
import { formatBytes, formatPercent } from '@/utils/format';

export const MEMORY_PERCENT_BASES = ['limit', 'host'] as const;
export type MemoryPercentBasis = (typeof MEMORY_PERCENT_BASES)[number];

/** Anything but a known value is the default, so a stale or hand-edited row cannot break the display. */
export function parseMemoryPercentBasis(value: unknown): MemoryPercentBasis {
  return value === 'host' ? 'host' : 'limit';
}

export interface MemoryPercentView {
  /** The percent to show and to size the bar with. */
  percent: number;
  /** The percent that picks the bar color: the larger of the shown percent and the limit percent. */
  level: number;
  /** What `percent` is really of. 'limit' when the host basis was asked for but host memory is unknown. */
  basis: MemoryPercentBasis;
  /** True when the container has its own limit below host memory. */
  capped: boolean;
  /** Short label after the percent, e.g. "of limit". */
  suffix: string;
  /** Full sentence for a tooltip. */
  title: string;
}

export function memoryPercentView(stats: ContainerStats, requested: MemoryPercentBasis): MemoryPercentView {
  const host = stats.hostMemory ?? 0;
  const limit = stats.memoryLimit;
  // Docker, and both backends, report host memory as the limit of a container
  // without one. Without the host figure there is no telling, so call it capped.
  const capped = limit > 0 && (host <= 0 || limit < host);
  const used = formatBytes(stats.memoryUsage);
  const limitPercent = stats.memoryPercent;

  if (requested === 'host' && host > 0) {
    const percent = (stats.memoryUsage / host) * 100;
    const hostText = `${used} of ${formatBytes(host)} host memory`;
    return {
      percent,
      level: capped ? Math.max(percent, limitPercent) : percent,
      basis: 'host',
      capped,
      suffix: 'of host',
      title: capped
        ? `${hostText}. The container limit is ${formatBytes(limit)}, and ${formatPercent(limitPercent)} of it is used.`
        : `${hostText}. No container limit is set.`,
    };
  }

  const fallback = requested === 'host' ? ' Host memory is not known, so this is the share of the limit.' : '';
  if (!capped) {
    return {
      percent: limitPercent,
      level: limitPercent,
      basis: 'limit',
      capped,
      suffix: host > 0 ? 'of host' : 'of limit',
      title:
        host > 0
          ? `${used} of ${formatBytes(host)} host memory. No container limit is set, so the host is the limit.${fallback}`
          : `${used} of ${formatBytes(limit)}.${fallback}`,
    };
  }
  return {
    percent: limitPercent,
    level: limitPercent,
    basis: 'limit',
    capped,
    suffix: 'of limit',
    title: `${used} of the ${formatBytes(limit)} container limit.${fallback}`,
  };
}

/** "952.4 MB / 4.0 GB (23.3% of limit)", for the wide stats bar. The limit shown is always the real one. */
export function memoryDetailText(stats: ContainerStats, view: MemoryPercentView): string {
  return `${formatBytes(stats.memoryUsage)} / ${formatBytes(stats.memoryLimit)} (${formatPercent(view.percent)} ${view.suffix})`;
}
