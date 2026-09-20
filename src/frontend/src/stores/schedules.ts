import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Schedule, ScheduleHistoryEntry, BackupEntry, ScheduleRunnerState } from '@/types/schedule';
import { apiFetch } from '@/utils/csrf';

const API_BASE = '/plugins/unraid-docker-folders-modern/api';
const FETCH_DEBOUNCE_MS = 500;

export const useScheduleStore = defineStore('schedules', () => {
  const schedules = ref<Schedule[]>([]);
  const runner = ref<ScheduleRunnerState | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let lastFetchTime = 0;

  const scheduleCount = computed(() => schedules.value.length);

  /**
   * True when nothing is running the schedules, so the UI must say so.
   *
   * The cron entry can be missing, or it can be present while the runner
   * never fires. A stale heartbeat catches both. Stays false until the first
   * response arrives, so the warning does not flash during load.
   */
  const runnerStalled = computed(() => {
    const state = runner.value;
    if (!state) return false;
    return !state.cron_installed || state.stale;
  });

  function schedulesForTarget(targetType: string, targetId: string) {
    return schedules.value.filter(
      (s) => s.target_type === targetType && s.target_id === targetId,
    );
  }

  async function fetchSchedules(force = false) {
    const now = Date.now();
    if (!force && now - lastFetchTime < FETCH_DEBOUNCE_MS) {
      return;
    }
    lastFetchTime = now;

    loading.value = true;
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/schedules.php`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      schedules.value = data.schedules || [];
      runner.value = data.runner || null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch schedules';
      console.error('Error fetching schedules:', e);
    } finally {
      loading.value = false;
    }
  }

  async function createSchedule(data: Partial<Schedule>): Promise<{ success: boolean; id?: number; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok) {
        return { success: false, error: result.message || 'Failed to create schedule' };
      }
      await fetchSchedules(true);
      return { success: true, id: result.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create schedule';
      return { success: false, error: msg };
    }
  }

  async function updateSchedule(id: number, data: Partial<Schedule>): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?id=${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      if (response.ok) {
        await fetchSchedules(true);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Error updating schedule:', e);
      return false;
    }
  }

  async function deleteSchedule(id: number): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?id=${id}`, {
        method: 'DELETE',
      });
      if (response.ok) {
        schedules.value = schedules.value.filter((s) => s.id !== id);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Error deleting schedule:', e);
      return false;
    }
  }

  async function toggleSchedule(id: number, enabled: boolean): Promise<boolean> {
    const schedule = schedules.value.find((s) => s.id === id);
    if (schedule) {
      schedule.enabled = enabled;
    }

    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=toggle&id=${id}`, {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        if (schedule) schedule.enabled = !enabled;
        return false;
      }
      await fetchSchedules(true);
      return true;
    } catch (e) {
      if (schedule) schedule.enabled = !enabled;
      console.error('Error toggling schedule:', e);
      return false;
    }
  }

  /**
   * Commit many enable/disable changes in one request.
   *
   * Not optimistic: the caller (Manage mode) has been showing staged state
   * locally and refetches on success, so there is nothing to roll back.
   */
  async function bulkSetEnabled(
    updates: { id: number; enabled: boolean }[],
  ): Promise<{ success: boolean; error?: string }> {
    if (updates.length === 0) return { success: true };

    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=bulk_toggle`, {
        method: 'POST',
        body: JSON.stringify({ updates }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        return { success: false, error: result.message || `HTTP ${response.status}` };
      }
      await fetchSchedules(true);
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Failed to update schedules' };
    }
  }

  async function bulkDelete(ids: number[]): Promise<{ success: boolean; error?: string }> {
    if (ids.length === 0) return { success: true };

    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=bulk_delete`, {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        return { success: false, error: result.message || `HTTP ${response.status}` };
      }
      schedules.value = schedules.value.filter((s) => !ids.includes(s.id));
      await fetchSchedules(true);
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Failed to delete schedules' };
    }
  }

  async function runScheduleNow(id: number): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=run&id=${id}`, {
        method: 'POST',
      });
      const result = await response.json();
      await fetchSchedules(true);
      return { success: result.success, message: result.message };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to run schedule';
      return { success: false, message: msg };
    }
  }

  /**
   * Rewrite the cron file and rebuild root's crontab.
   *
   * The runner heartbeat only updates once a minute, so the returned state is
   * still stale right after a repair. The warning clears the next time the
   * schedules screen opens and refetches.
   */
  async function repairCron(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=repair_cron`, {
        method: 'POST',
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        return { success: false, error: result.message || `HTTP ${response.status}` };
      }
      const result = await response.json();
      runner.value = result.runner || runner.value;
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Failed to repair cron' };
    }
  }

  async function getHistory(id: number, limit = 50): Promise<ScheduleHistoryEntry[]> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=history&id=${id}&limit=${limit}`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.history || [];
    } catch (e) {
      console.error('Error fetching schedule history:', e);
      return [];
    }
  }

  async function getBackups(targetType: string, targetId: string): Promise<BackupEntry[]> {
    try {
      const response = await apiFetch(
        `${API_BASE}/schedules.php?action=backups&target_type=${encodeURIComponent(targetType)}&target_id=${encodeURIComponent(targetId)}`,
      );
      if (!response.ok) return [];
      const data = await response.json();
      return data.backups || [];
    } catch (e) {
      console.error('Error fetching backups:', e);
      return [];
    }
  }

  async function deleteBackup(path: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/schedules.php?action=delete_backup`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
      return response.ok;
    } catch (e) {
      console.error('Error deleting backup:', e);
      return false;
    }
  }

  return {
    schedules,
    runner,
    runnerStalled,
    repairCron,
    loading,
    error,
    scheduleCount,
    schedulesForTarget,
    fetchSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    toggleSchedule,
    bulkSetEnabled,
    bulkDelete,
    runScheduleNow,
    getHistory,
    getBackups,
    deleteBackup,
  };
});
