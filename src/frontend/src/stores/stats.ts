/**
 * Stats Store - Manages live container resource stats.
 *
 * Tracks two sets of container IDs:
 * - visibleIds: running containers with mounted cards (compact bars)
 * - expandedIds: containers with accordion open (detailed stats)
 *
 * Runs while either set is non-empty and the tab is visible. When the backend
 * has `live` (GraphQL mode), the server pushes stats over a subscription and
 * the store reopens it whenever the set changes. Otherwise, or while a broken
 * stream waits to be retried, the store polls.
 */

import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { useBackend } from '@/backends';
import { useSettingsStore } from '@/stores/settings';

export interface ContainerStats {
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
  /** Online CPU cores on the host. Optional: a backend older than this field omits it. */
  hostCpus?: number;
  /** Host MemTotal in bytes. Optional for the same reason. */
  hostMemory?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
/** How long to poll after a stats stream ends unexpectedly, before opening it again. */
const STREAM_RETRY_MS = 15000;

export const useStatsStore = defineStore('stats', () => {
  const visibleIds = ref(new Set<string>());
  const expandedIds = ref(new Set<string>());
  const stats = ref<Record<string, ContainerStats | null>>({});
  const loading = ref(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityBound = false;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  /** True while stats are being tracked, by stream or by poll. */
  let active = false;
  let closeStream: (() => void) | null = null;
  /** The ids the open stream covers, sorted and joined, so an unchanged set is not reopened. */
  let streamKey = '';
  let streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a stream ended unexpectedly; the store polls until the retry. */
  let streamBroken = false;

  const getStats = computed(() => {
    return (id: string): ContainerStats | null => stats.value[id] ?? null;
  });

  function allTrackedIds(): string[] {
    const combined = new Set<string>(visibleIds.value);
    for (const id of expandedIds.value) combined.add(id);
    return Array.from(combined);
  }

  async function fetchStats() {
    const ids = allTrackedIds();
    if (ids.length === 0) return;

    loading.value = true;
    try {
      const { ok, error: failure, data } = await useBackend().stats.get(ids);
      if (!ok) throw new Error(failure);
      const incoming = data.stats || {};
      for (const id of ids) {
        stats.value[id] = incoming[id] ?? null;
      }
    } catch (e) {
      console.error('Error fetching stats:', e);
    } finally {
      loading.value = false;
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopPolling();
    } else if (allTrackedIds().length > 0) {
      startPolling();
    }
  }

  function canStream(): boolean {
    return !streamBroken && useBackend().live !== undefined;
  }

  /**
   * Open the stats stream for the current set, closing any stream already
   * open. The server sends the first reading at once, so this also serves as
   * the immediate fetch that polling does on a change.
   */
  function openStream() {
    const live = useBackend().live;
    const ids = allTrackedIds();
    // How often the server pushes, on every page including the dashboard tile.
    // The `stats_refresh_interval` setting, in seconds. `setPollInterval` does
    // not change it: a pushed reading is shared by every open tab, where a
    // poll is a whole request per tab.
    const intervalMs = useSettingsStore().statsRefreshInterval * 1000;
    const key = `${intervalMs}:${[...ids].sort().join(',')}`;
    if (closeStream && key === streamKey) return;

    closeStream?.();
    closeStream = null;
    if (!live || ids.length === 0) return;

    streamKey = key;

    closeStream = live.stats(ids, intervalMs, {
      onData: (incoming) => {
        for (const id of ids) {
          stats.value[id] = incoming[id] ?? null;
        }
      },
      onEnd: (error) => {
        closeStream = null;
        if (!active) return;
        // A dead stream is silent, so poll until it can be opened again.
        // This keeps GraphQL mode no worse than polling when the API
        // restarts or the connection drops.
        console.warn('Stats stream ended, polling instead:', error ?? 'closed by server');
        streamBroken = true;
        fetchStats();
        restartTimer();
        if (streamRetryTimer) clearTimeout(streamRetryTimer);
        streamRetryTimer = setTimeout(retryStream, STREAM_RETRY_MS);
      },
    });
  }

  function retryStream() {
    streamRetryTimer = null;
    streamBroken = false;
    if (!active) return;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    openStream();
  }

  function startPolling() {
    if (!visibilityBound) {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      visibilityBound = true;
    }
    if (active) return;
    if (document.hidden) return;
    active = true;
    // Debounce the initial fetch so all registrations from the same
    // render cycle are batched into a single request.
    scheduleKick();
    if (!canStream()) restartTimer();
  }

  /** Start the poll timer at the current rate, replacing any timer already running. */
  function restartTimer() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchStats, pollIntervalMs);
  }

  function scheduleKick() {
    if (kickTimer) clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
      kickTimer = null;
      if (canStream()) {
        if (active) openStream();
        return;
      }
      fetchStats();
      // Reset the interval so the next poll is a full interval from now
      if (pollTimer) restartTimer();
    }, 50);
  }

  /**
   * The dashboard widget polls slower than the Folders page. A running timer
   * restarts at the new rate. Polling only: a stream runs at the
   * `stats_refresh_interval` setting.
   */
  function setPollInterval(ms: number) {
    pollIntervalMs = ms;
    if (pollTimer) restartTimer();
  }

  // The settings usually load after the first stream opens, and a settings
  // refetch can change the interval. An open stream reopens at the new rate;
  // `openStream` sees the changed key.
  watch(
    () => useSettingsStore().statsRefreshInterval,
    () => {
      if (closeStream) openStream();
    },
  );

  function stopPolling() {
    active = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    closeStream?.();
    closeStream = null;
    if (streamRetryTimer) {
      clearTimeout(streamRetryTimer);
      streamRetryTimer = null;
    }
    streamBroken = false;
  }

  function ensurePolling() {
    if (allTrackedIds().length > 0) {
      startPolling();
    } else {
      stopPolling();
    }
  }

  function registerVisible(id: string) {
    const isNew = !visibleIds.value.has(id);
    visibleIds.value.add(id);
    visibleIds.value = new Set(visibleIds.value);
    ensurePolling();
    if (isNew && active) scheduleKick();
  }

  function unregisterVisible(id: string) {
    visibleIds.value.delete(id);
    visibleIds.value = new Set(visibleIds.value);
    ensurePolling();
  }

  function registerExpanded(id: string) {
    const isNew = !expandedIds.value.has(id);
    expandedIds.value.add(id);
    expandedIds.value = new Set(expandedIds.value);
    ensurePolling();
    if (isNew && active) scheduleKick();
  }

  function unregisterExpanded(id: string) {
    expandedIds.value.delete(id);
    expandedIds.value = new Set(expandedIds.value);
    ensurePolling();
  }

  function cleanup() {
    stopPolling();
    if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
    if (visibilityBound) {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      visibilityBound = false;
    }
    visibleIds.value = new Set();
    expandedIds.value = new Set();
    stats.value = {};
  }

  return {
    stats,
    loading,
    getStats,
    registerVisible,
    unregisterVisible,
    registerExpanded,
    unregisterExpanded,
    setPollInterval,
    cleanup,
  };
});
