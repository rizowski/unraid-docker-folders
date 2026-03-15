/**
 * Compose Store - Manages Docker Compose stack state and operations
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ComposeStack, ComposeStatus, ComposeImportResult } from '@/types/compose';
import { apiFetch } from '@/utils/csrf';

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useComposeStore = defineStore('compose', () => {
  // State
  const stacks = ref<ComposeStack[]>([]);
  const status = ref<ComposeStatus>({
    compose_available: false,
    compose_version: null,
    compose_plugin_installed: false,
    management_enabled: false,
  });
  const loading = ref(false);
  const error = ref<string | null>(null);
  const installingBinary = ref(false);
  let lastFetchTime = 0;
  const FETCH_DEBOUNCE_MS = 500;
  let initialLoadDone = false;

  // Getters
  const stackCount = computed(() => stacks.value.length);

  function getStackByProject(project: string) {
    return stacks.value.find((s) => s.project_name === project);
  }

  const composeAvailable = computed(() => status.value.compose_available);
  const managementEnabled = computed(() => status.value.management_enabled);
  const composePluginInstalled = computed(() => status.value.compose_plugin_installed);

  // Actions
  async function fetchStatus() {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?action=status`);
      if (response.ok) {
        const data = await response.json();
        status.value = data;
      }
    } catch (e) {
      console.error('Error fetching compose status:', e);
    }
  }

  async function fetchStacks(force = false) {
    const now = Date.now();
    if (!force && now - lastFetchTime < FETCH_DEBOUNCE_MS) {
      return;
    }
    lastFetchTime = now;

    if (!initialLoadDone) {
      loading.value = true;
    }
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/compose.php?action=list`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      stacks.value = data.stacks || [];
      initialLoadDone = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error fetching compose stacks:', e);
    } finally {
      loading.value = false;
    }
  }

  async function installBinary(): Promise<boolean> {
    installingBinary.value = true;
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/compose.php?action=install_binary`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to install Docker Compose');
      }

      const data = await response.json();
      status.value = data.status;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error installing compose binary:', e);
      return false;
    } finally {
      installingBinary.value = false;
    }
  }

  async function stackUp(project: string, forceRecreate = false): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=up`, {
        method: 'POST',
        body: JSON.stringify({ force_recreate: forceRecreate }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to start stack');
      }

      await fetchStacks(true);
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error starting stack:', e);
      return { success: false, error: msg };
    }
  }

  async function stackDown(project: string): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=down`, {
        method: 'POST',
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to stop stack');
      }

      await fetchStacks(true);
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error stopping stack:', e);
      return { success: false, error: msg };
    }
  }

  async function stackRestart(project: string): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=restart`, {
        method: 'POST',
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to restart stack');
      }

      await fetchStacks(true);
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error restarting stack:', e);
      return { success: false, error: msg };
    }
  }

  async function stackPull(project: string): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=pull`, {
        method: 'POST',
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Failed to pull images');
      }

      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error pulling images:', e);
      return { success: false, error: msg };
    }
  }

  async function getComposeFile(project: string): Promise<{ content: string | null; path: string | null; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=file`);
      const data = await response.json();

      if (!response.ok) {
        return { content: null, path: null, error: data.message };
      }

      return { content: data.content, path: data.path };
    } catch (e) {
      return { content: null, path: null, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function saveComposeFile(project: string, content: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=save_file`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to save compose file');
      }

      return true;
    } catch (e) {
      console.error('Error saving compose file:', e);
      return false;
    }
  }

  async function getEnvFile(project: string): Promise<{ content: string | null; path: string | null; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=env`);
      const data = await response.json();

      if (!response.ok) {
        return { content: null, path: null, error: data.message };
      }

      return { content: data.content, path: data.path };
    } catch (e) {
      return { content: null, path: null, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function saveEnvFile(project: string, content: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=save_env`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to save env file');
      }

      return true;
    } catch (e) {
      console.error('Error saving env file:', e);
      return false;
    }
  }

  async function setEnvPath(project: string, path: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=set_env_path`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      });

      if (!response.ok) {
        throw new Error('Failed to set env file path');
      }

      await fetchStacks(true);
      return true;
    } catch (e) {
      console.error('Error setting env path:', e);
      return false;
    }
  }

  async function setAutostart(project: string, enabled: boolean, forceRecreate = false): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=autostart`, {
        method: 'POST',
        body: JSON.stringify({ enabled, force_recreate: forceRecreate }),
      });

      if (!response.ok) {
        throw new Error('Failed to set autostart');
      }

      // Update local state
      const stack = stacks.value.find((s) => s.project_name === project);
      if (stack) {
        stack.autostart = enabled;
        stack.autostart_force_recreate = forceRecreate;
      }

      return true;
    } catch (e) {
      console.error('Error setting autostart:', e);
      return false;
    }
  }

  async function getLogs(project: string, tail = 100): Promise<{ output: string; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=logs&tail=${tail}`);
      const data = await response.json();
      return { output: data.output || '', error: data.error || undefined };
    } catch (e) {
      return { output: '', error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function importFromComposePlugin(): Promise<ComposeImportResult | null> {
    loading.value = true;
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/compose.php?action=import`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Import failed');
      }

      const result = await response.json();

      // Refresh stacks and status
      await Promise.all([fetchStacks(true), fetchStatus()]);

      return result;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error importing from compose plugin:', e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  return {
    // State
    stacks,
    status,
    loading,
    error,
    installingBinary,

    // Getters
    stackCount,
    getStackByProject,
    composeAvailable,
    managementEnabled,
    composePluginInstalled,

    // Actions
    fetchStatus,
    fetchStacks,
    installBinary,
    stackUp,
    stackDown,
    stackRestart,
    stackPull,
    getComposeFile,
    saveComposeFile,
    getEnvFile,
    saveEnvFile,
    setEnvPath,
    setAutostart,
    getLogs,
    importFromComposePlugin,
  };
});
