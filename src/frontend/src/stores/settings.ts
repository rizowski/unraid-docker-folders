/**
 * Settings Store - Manages plugin settings persisted in backend SQLite
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useBackend } from '@/backends';
import { SORT_MODE_OPTIONS, type SortMode } from '@/types/folder';
import { formatTimestamp } from '@/utils/format';

export const useSettingsStore = defineStore('settings', () => {
  const distinguishHealthy = ref(true);
  const sortMode = ref<SortMode>('manual');
  /** Whether an automatic sort mode also reorders folders. Off keeps the folder drag order. */
  const sortFolders = ref(false);
  const showStats = ref(true);
  const replaceDockerSection = ref(true);
  const showFolderPorts = ref(true);
  const showInlineLogs = ref(false);
  /** Offer to hand a CLI-created container over to Unraid's container manager. */
  const enableAdopt = ref(true);
  const enableSecurityAdvisor = ref(true);
  const logRefreshInterval = ref(10);
  const enableUpdateChecks = ref(false);
  const updateCheckSchedule = ref('disabled');
  const notifyOnUpdates = ref(false);
  const updateCheckExclude = ref('');
  const postPullAction = ref('pull_only');
  /** How many containers to pull + recreate at once during a batch update. */
  const updateConcurrency = ref(3);
  const backupDestination = ref('/mnt/user/backups/docker-folders');
  const defaultRetentionCount = ref(7);
  /** Read-only: the timezone the backend PHP process is actually running in. */
  const serverTimezone = ref<string | null>(null);
  const loaded = ref(false);

  async function fetchSettings() {
    try {
      const { ok, data } = await useBackend().settings.getAll();
      if (!ok) return;

      const settings = data.settings || {};

      if ('distinguish_healthy' in settings) {
        distinguishHealthy.value = settings.distinguish_healthy !== '0';
      }
      if ('sort_mode' in settings) {
        const mode = settings.sort_mode as SortMode;
        sortMode.value = SORT_MODE_OPTIONS.some((o) => o.value === mode) ? mode : 'manual';
      }
      if ('sort_folders' in settings) {
        sortFolders.value = settings.sort_folders === '1';
      }
      if ('show_stats' in settings) {
        showStats.value = settings.show_stats !== '0';
      }
      if ('replace_docker_section' in settings) {
        replaceDockerSection.value = settings.replace_docker_section === '1';
      }
      if ('show_folder_ports' in settings) {
        showFolderPorts.value = settings.show_folder_ports !== '0';
      }
      if ('show_inline_logs' in settings) {
        showInlineLogs.value = settings.show_inline_logs === '1';
      }
      if ('enable_adopt' in settings) {
        enableAdopt.value = settings.enable_adopt !== '0';
      }
      if ('enable_security_advisor' in settings) {
        enableSecurityAdvisor.value = settings.enable_security_advisor !== '0';
      }
      if ('log_refresh_interval' in settings) {
        const parsed = parseInt(settings.log_refresh_interval, 10);
        logRefreshInterval.value = Number.isNaN(parsed) ? 10 : parsed;
      }
      if ('enable_update_checks' in settings) {
        enableUpdateChecks.value = settings.enable_update_checks === '1';
      }
      if ('update_check_schedule' in settings) {
        updateCheckSchedule.value = settings.update_check_schedule || 'disabled';
      }
      if ('notify_on_updates' in settings) {
        notifyOnUpdates.value = settings.notify_on_updates === '1';
      }
      if ('update_check_exclude' in settings) {
        updateCheckExclude.value = settings.update_check_exclude || '';
      }
      if ('post_pull_action' in settings) {
        postPullAction.value = settings.post_pull_action || 'pull_only';
      }
      if ('update_concurrency' in settings) {
        const parsed = parseInt(settings.update_concurrency, 10);
        updateConcurrency.value = Number.isNaN(parsed) ? 3 : Math.min(5, Math.max(1, parsed));
      }
      if ('backup_destination' in settings) {
        backupDestination.value = settings.backup_destination || '/mnt/user/backups/docker-folders';
      }
      if ('default_retention_count' in settings) {
        const parsed = parseInt(settings.default_retention_count, 10);
        defaultRetentionCount.value = Number.isNaN(parsed) ? 7 : parsed;
      }
      if ('server_timezone' in settings) {
        serverTimezone.value = settings.server_timezone || null;
      }

      loaded.value = true;
    } catch (e) {
      console.error('Error fetching settings:', e);
    }
  }

  async function setDistinguishHealthy(value: boolean) {
    distinguishHealthy.value = value;

    try {
      await useBackend().settings.set('distinguish_healthy', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setSortMode(value: SortMode) {
    sortMode.value = value;

    try {
      await useBackend().settings.set('sort_mode', value);
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setSortFolders(value: boolean) {
    sortFolders.value = value;

    try {
      await useBackend().settings.set('sort_folders', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setShowStats(value: boolean) {
    showStats.value = value;

    try {
      await useBackend().settings.set('show_stats', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setShowFolderPorts(value: boolean) {
    showFolderPorts.value = value;

    try {
      await useBackend().settings.set('show_folder_ports', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setShowInlineLogs(value: boolean) {
    showInlineLogs.value = value;

    try {
      await useBackend().settings.set('show_inline_logs', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setEnableAdopt(value: boolean) {
    enableAdopt.value = value;

    try {
      await useBackend().settings.set('enable_adopt', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setEnableSecurityAdvisor(value: boolean) {
    enableSecurityAdvisor.value = value;

    try {
      await useBackend().settings.set('enable_security_advisor', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setLogRefreshInterval(value: number) {
    logRefreshInterval.value = value;

    try {
      await useBackend().settings.set('log_refresh_interval', String(value));
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setEnableUpdateChecks(value: boolean) {
    enableUpdateChecks.value = value;

    try {
      await useBackend().settings.set('enable_update_checks', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setUpdateCheckSchedule(value: string) {
    updateCheckSchedule.value = value;

    try {
      await useBackend().settings.set('update_check_schedule', value);
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setNotifyOnUpdates(value: boolean) {
    notifyOnUpdates.value = value;

    try {
      await useBackend().settings.set('notify_on_updates', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setUpdateCheckExclude(value: string) {
    updateCheckExclude.value = value;

    try {
      await useBackend().settings.set('update_check_exclude', value);
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setPostPullAction(value: string) {
    postPullAction.value = value;

    try {
      await useBackend().settings.set('post_pull_action', value);
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setUpdateConcurrency(value: number) {
    const clamped = Math.min(5, Math.max(1, Math.round(value)));
    updateConcurrency.value = clamped;

    try {
      await useBackend().settings.set('update_concurrency', String(clamped));
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setBackupDestination(value: string) {
    backupDestination.value = value;

    try {
      await useBackend().settings.set('backup_destination', value);
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setDefaultRetentionCount(value: number) {
    defaultRetentionCount.value = value;

    try {
      await useBackend().settings.set('default_retention_count', String(value));
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setReplaceDockerSection(value: boolean) {
    replaceDockerSection.value = value;

    try {
      await useBackend().settings.set('replace_docker_section', value ? '1' : '0');
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  /** Render a unix timestamp in the server zone when it is known. */
  function formatServerTime(unixSeconds: number): string {
    return formatTimestamp(unixSeconds, serverTimezone.value);
  }

  return {
    distinguishHealthy,
    sortMode,
    sortFolders,
    setSortFolders,
    showStats,
    replaceDockerSection,
    showFolderPorts,
    showInlineLogs,
    enableAdopt,
    enableSecurityAdvisor,
    logRefreshInterval,
    enableUpdateChecks,
    updateCheckSchedule,
    notifyOnUpdates,
    updateCheckExclude,
    postPullAction,
    updateConcurrency,
    backupDestination,
    defaultRetentionCount,
    serverTimezone,
    formatServerTime,
    loaded,
    fetchSettings,
    setDistinguishHealthy,
    setSortMode,
    setShowStats,
    setShowFolderPorts,
    setShowInlineLogs,
    setEnableAdopt,
    setEnableSecurityAdvisor,
    setLogRefreshInterval,
    setEnableUpdateChecks,
    setUpdateCheckSchedule,
    setNotifyOnUpdates,
    setUpdateCheckExclude,
    setPostPullAction,
    setUpdateConcurrency,
    setBackupDestination,
    setDefaultRetentionCount,
    setReplaceDockerSection,
  };
});
