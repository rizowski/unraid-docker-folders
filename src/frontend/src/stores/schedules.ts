import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Schedule, ScheduleHistoryEntry, BackupEntry, ScheduleRunnerState } from '@/types/schedule';
import { useBackend } from '@/backends';

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
   *
   * With nothing enabled the cron entry is correctly absent and the heartbeat
   * correctly goes stale, so there is no fault to report.
   */
  const runnerStalled = computed(() => {
    const state = runner.value;
    if (!state) return false;
    if (!schedules.value.some((s) => s.enabled)) return false;
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
      const { ok, error: failure, data } = await useBackend().schedules.list();
      if (!ok) {
        throw new Error(failure);
      }
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
      const { ok, data: result } = await useBackend().schedules.create(data);
      if (!ok) {
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
      const { ok } = await useBackend().schedules.update(id, data);
      if (ok) {
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
      const { ok } = await useBackend().schedules.remove(id);
      if (ok) {
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
      const { ok } = await useBackend().schedules.toggle(id, { enabled });
      if (!ok) {
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
      const { ok, error: failure } = await useBackend().schedules.bulkToggle({ updates });
      if (!ok) {
        return { success: false, error: failure };
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
      const { ok, error: failure } = await useBackend().schedules.bulkDelete({ ids });
      if (!ok) {
        return { success: false, error: failure };
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
      const { data: result } = await useBackend().schedules.run(id);
      await fetchSchedules(true);
      return { success: result.success ?? false, message: result.message };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to run schedule';
      return { success: false, message: msg };
    }
  }

  async function getHistory(id: number, limit = 50): Promise<ScheduleHistoryEntry[]> {
    try {
      const { ok, data } = await useBackend().schedules.history(id, limit);
      if (!ok) return [];
      return data.history || [];
    } catch (e) {
      console.error('Error fetching schedule history:', e);
      return [];
    }
  }

  async function getBackups(targetType: string, targetId: string): Promise<BackupEntry[]> {
    try {
      const { ok, data } = await useBackend().schedules.backups(targetType, targetId);
      if (!ok) return [];
      return data.backups || [];
    } catch (e) {
      console.error('Error fetching backups:', e);
      return [];
    }
  }

  async function deleteBackup(path: string): Promise<boolean> {
    try {
      const { ok } = await useBackend().schedules.deleteBackup({ path });
      return ok;
    } catch (e) {
      console.error('Error deleting backup:', e);
      return false;
    }
  }

  return {
    schedules,
    runner,
    runnerStalled,
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
