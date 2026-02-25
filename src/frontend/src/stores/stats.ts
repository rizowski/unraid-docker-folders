/**
 * Stats Store - Manages live container resource stats with polling.
 *
 * Tracks two sets of container IDs:
 * - visibleIds: running containers with mounted cards (compact bars)
 * - expandedIds: containers with accordion open (detailed stats)
 *
 * Polls when either set is non-empty.
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { apiFetch } from '@/utils/csrf';

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
}

const API_BASE = '/plugins/unraid-docker-folders-modern/api';
const POLL_INTERVAL_MS = 5000;

export const useStatsStore = defineStore('stats', () => {
  const visibleIds = ref(new Set<string>());
  const expandedIds = ref(new Set<string>());
  const stats = ref<Record<string, ContainerStats | null>>({});
  const loading = ref(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;

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
      const response = await apiFetch(`${API_BASE}/stats.php?ids=${ids.join(',')}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
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

  function startPolling() {
    if (pollTimer) return;
    // Debounce the initial fetch so all registrations from the same
    // render cycle are batched into a single request.
    scheduleKick();
    pollTimer = setInterval(fetchStats, POLL_INTERVAL_MS);
  }

  function scheduleKick() {
    if (kickTimer) clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
      kickTimer = null;
      fetchStats();
      // Reset the interval so the next poll is a full POLL_INTERVAL_MS from now
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = setInterval(fetchStats, POLL_INTERVAL_MS);
      }
    }, 50);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
    if (isNew && pollTimer) scheduleKick();
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
    if (isNew && pollTimer) scheduleKick();
  }

  function unregisterExpanded(id: string) {
    expandedIds.value.delete(id);
    expandedIds.value = new Set(expandedIds.value);
    ensurePolling();
  }

  function cleanup() {
    stopPolling();
    if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
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
    cleanup,
  };
});
