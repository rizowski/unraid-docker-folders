/**
 * Formatting utilities for container stats display.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(decimals)} ${BYTE_UNITS[i] || 'B'}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

/**
 * Time from now until `unixSeconds`, e.g. "in 8h 5m".
 *
 * The mirror of formatUptime, which counts backwards from a start time; this
 * counts forwards to a scheduled one. A time that has already passed reads
 * "due" rather than a negative duration — a schedule whose next run is in the
 * past is waiting on the cron runner, not overdue by a measurable amount.
 */
export function formatTimeUntil(unixSeconds: number): string {
  const diffMs = unixSeconds * 1000 - Date.now();
  if (diffMs <= 0) return 'due';

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `in ${days}d ${hours % 24}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return 'in < 1m';
}

export function formatDuration(startSec: number, endSec: number): string {
  const s = endSec - startSec;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type ScheduleRunStatus = 'success' | 'error' | 'skipped';

export function scheduleStatusClass(status: string): string {
  switch (status) {
    case 'success': return 'text-success';
    case 'error': return 'text-error';
    default: return 'text-text-secondary';
  }
}

export function formatUptime(isoDate: string): string {
  if (!isoDate) return 'N/A';
  const start = new Date(isoDate).getTime();
  const now = Date.now();
  const diffMs = now - start;
  if (diffMs < 0) return 'N/A';

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}
