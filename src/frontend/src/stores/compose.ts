/**
 * Compose Store - Manages Docker Compose stack state and operations
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ComposeStack, ComposeStatus, ComposeImportResult, ComposeFileVersion, ComposeFileVersionDetail } from '@/types/compose';
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
    compose_plugin_data_exists: false,
  });
  const loading = ref(false);
  const error = ref<string | null>(null);
  const installingBinary = ref(false);
  const statusChecked = ref(false);
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
        statusChecked.value = true;
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

  async function stackStop(project: string): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=stop`, {
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

  async function validateCompose(
    project: string,
    content?: string,
  ): Promise<{ success: boolean; errors: { line: number; column?: number; message: string }[]; output?: string }> {
    try {
      const response = await apiFetch(
        `${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=validate`,
        {
          method: 'POST',
          body: content !== undefined ? JSON.stringify({ content }) : undefined,
          headers: content !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        },
      );
      const data = await response.json();
      return {
        success: !!data.success,
        errors: Array.isArray(data.errors) ? data.errors : [],
        output: data.output,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return { success: false, errors: [{ line: 1, message: msg }] };
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

  async function importFromComposePlugin(): Promise<ComposeImportResult> {
    loading.value = true;
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/compose.php?action=import`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || `Import failed (HTTP ${response.status})`);
      }

      const result: ComposeImportResult = await response.json();

      // Refresh stacks and status
      await Promise.all([fetchStacks(true), fetchStatus()]);

      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      error.value = msg;
      console.error('Error importing from compose plugin:', e);
      return {
        success: false,
        stacks_imported: 0,
        stacks_skipped: 0,
        errors: [msg],
      };
    } finally {
      loading.value = false;
    }
  }

  async function createStack(
    projectName: string,
    composeContent: string,
    envContent: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await apiFetch(`${API_BASE}/compose.php?action=create`, {
        method: 'POST',
        body: JSON.stringify({
          project_name: projectName,
          compose_content: composeContent,
          env_content: envContent,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        return { success: false, error: data.message || 'Failed to create stack' };
      }

      // Refresh stacks and folders
      await Promise.all([fetchStacks(true), fetchStatus()]);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return { success: false, error: msg };
    }
  }

  async function getFileVersions(
    project: string,
    fileType: 'compose' | 'env' = 'compose',
  ): Promise<{ versions: ComposeFileVersion[] }> {
    try {
      const response = await apiFetch(
        `${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=versions&file_type=${fileType}`,
      );
      const data = await response.json();
      return { versions: data.versions || [] };
    } catch (e) {
      console.error('Error fetching file versions:', e);
      return { versions: [] };
    }
  }

  async function getFileVersionContent(
    project: string,
    versionId: number,
  ): Promise<{ version: ComposeFileVersionDetail | null; error?: string }> {
    try {
      const response = await apiFetch(
        `${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=version&version_id=${versionId}`,
      );
      const data = await response.json();
      if (!response.ok) {
        return { version: null, error: data.message };
      }
      return { version: data.version };
    } catch (e) {
      return { version: null, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function restoreFileVersion(project: string, versionId: number): Promise<boolean> {
    try {
      const response = await apiFetch(
        `${API_BASE}/compose.php?project=${encodeURIComponent(project)}&action=restore_version`,
        {
          method: 'POST',
          body: JSON.stringify({ version_id: versionId }),
        },
      );
      return response.ok;
    } catch (e) {
      console.error('Error restoring file version:', e);
      return false;
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
    statusChecked,

    // Actions
    fetchStatus,
    fetchStacks,
    installBinary,
    createStack,
    stackUp,
    stackDown,
    stackStop,
    stackRestart,
    stackPull,
    validateCompose,
    getComposeFile,
    saveComposeFile,
    getEnvFile,
    saveEnvFile,
    setEnvPath,
    setAutostart,
    getLogs,
    importFromComposePlugin,
    getFileVersions,
    getFileVersionContent,
    restoreFileVersion,
  };
});
