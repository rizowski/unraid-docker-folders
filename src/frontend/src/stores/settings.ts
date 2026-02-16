/**
 * Settings Store - Manages plugin settings persisted in backend SQLite
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiFetch } from '@/utils/csrf';

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useSettingsStore = defineStore('settings', () => {
  const distinguishHealthy = ref(true);
  const showStats = ref(true);
  const replaceDockerSection = ref(false);
  const showFolderPorts = ref(true);
  const loaded = ref(false);

  async function fetchSettings() {
    try {
      const response = await fetch(`${API_BASE}/settings.php`);
      if (!response.ok) return;

      const data = await response.json();
      const settings = data.settings || {};

      if ('distinguish_healthy' in settings) {
        distinguishHealthy.value = settings.distinguish_healthy !== '0';
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

      loaded.value = true;
    } catch (e) {
      console.error('Error fetching settings:', e);
    }
  }

  async function setDistinguishHealthy(value: boolean) {
    distinguishHealthy.value = value;

    try {
      await apiFetch(`${API_BASE}/settings.php`, {
        method: 'POST',
        body: JSON.stringify({ key: 'distinguish_healthy', value: value ? '1' : '0' }),
      });
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setShowStats(value: boolean) {
    showStats.value = value;

    try {
      await apiFetch(`${API_BASE}/settings.php`, {
        method: 'POST',
        body: JSON.stringify({ key: 'show_stats', value: value ? '1' : '0' }),
      });
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setShowFolderPorts(value: boolean) {
    showFolderPorts.value = value;

    try {
      await apiFetch(`${API_BASE}/settings.php`, {
        method: 'POST',
        body: JSON.stringify({ key: 'show_folder_ports', value: value ? '1' : '0' }),
      });
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  async function setReplaceDockerSection(value: boolean) {
    replaceDockerSection.value = value;

    try {
      await apiFetch(`${API_BASE}/settings.php`, {
        method: 'POST',
        body: JSON.stringify({ key: 'replace_docker_section', value: value ? '1' : '0' }),
      });
    } catch (e) {
      console.error('Error saving setting:', e);
    }
  }

  return {
    distinguishHealthy,
    showStats,
    replaceDockerSection,
    showFolderPorts,
    loaded,
    fetchSettings,
    setDistinguishHealthy,
    setShowStats,
    setShowFolderPorts,
    setReplaceDockerSection,
  };
});
