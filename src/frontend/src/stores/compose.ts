/**
 * Compose Store - Manages Docker Compose stack state and operations
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ComposeStack, ComposeStatus, ComposeImportResult, ComposeFileVersion, ComposeFileVersionDetail, ComposeValidationError } from '@/types/compose';
import { useBackend } from '@/backends';

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

  /**
   * Whether compose actions should be disabled.
   *
   * Compose buttons are rendered unconditionally and disabled when unusable,
   * rather than hidden until the status check resolves. Hiding them made the
   * toolbar and menus reflow a moment after load, which read as a blink.
   *
   * Disabled while the check is still in flight too, so an action cannot be
   * fired before we know whether it is supported.
   */
  const composeActionsDisabled = computed(
    () => !statusChecked.value || !status.value.management_enabled
  );

  /**
   * Why compose actions are disabled, for use as a button title.
   * Null when they are usable.
   */
  const composeDisabledReason = computed<string | null>(() => {
    if (!statusChecked.value) return 'Checking Docker Compose availability...';
    if (!status.value.compose_available) return 'Docker Compose is not installed';
    if (status.value.compose_plugin_installed) {
      return 'Disabled: the Compose Manager plugin is installed';
    }
    if (!status.value.management_enabled) return 'Compose management is unavailable';
    return null;
  });

  // Actions
  async function fetchStatus() {
    try {
      const { ok, data } = await useBackend().compose.status();
      if (ok) {
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
      const { ok, error: failure, data } = await useBackend().compose.list();

      if (!ok) {
        throw new Error(failure);
      }

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
      const { ok, data } = await useBackend().compose.installBinary();

      if (!ok) {
        throw new Error(data.message || 'Failed to install Docker Compose');
      }

      status.value = data.status as ComposeStatus;
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
      const { ok, data } = await useBackend().compose.stackAction(project, 'up', { force_recreate: forceRecreate });

      if (!ok) {
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
      const { ok, data } = await useBackend().compose.stackAction(project, 'down');

      if (!ok) {
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
      const { ok, data } = await useBackend().compose.stackAction(project, 'stop');

      if (!ok) {
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
      const { ok, data } = await useBackend().compose.stackAction(project, 'restart');

      if (!ok) {
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

  // Note: pulling a stack's images goes through the streaming endpoint
  // (api/compose-stream.php) via ComposeProgressModal, not through a store
  // action — a bare await gave no sign anything was happening.

  async function validateCompose(
    project: string,
    content?: string,
  ): Promise<{ success: boolean; errors: ComposeValidationError[]; output?: string }> {
    try {
      const { ok, error: failure, data } = await useBackend().compose.validate(project, content);
      // A validation failure answers 200 with `success: false`, so a non-ok
      // here means the request itself failed and there is nothing to report
      // line by line.
      if (!ok && !Array.isArray(data.errors)) {
        return { success: false, errors: [{ line: 1, message: failure ?? 'Request failed' }] };
      }
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
      const { ok, data } = await useBackend().compose.getFile(project);

      if (!ok) {
        return { content: null, path: null, error: data.message };
      }

      return { content: data.content ?? null, path: data.path ?? null };
    } catch (e) {
      return { content: null, path: null, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function saveComposeFile(project: string, content: string): Promise<boolean> {
    try {
      const { ok, data } = await useBackend().compose.saveFile(project, { content });

      if (!ok) {
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
      const { ok, data } = await useBackend().compose.getEnv(project);

      if (!ok) {
        return { content: null, path: null, error: data.message };
      }

      return { content: data.content ?? null, path: data.path ?? null };
    } catch (e) {
      return { content: null, path: null, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function saveEnvFile(project: string, content: string): Promise<boolean> {
    try {
      const { ok, data } = await useBackend().compose.saveEnv(project, { content });

      if (!ok) {
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
      const { ok } = await useBackend().compose.setEnvPath(project, { path });

      if (!ok) {
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
      const { ok } = await useBackend().compose.setAutostart(project, {
        enabled,
        force_recreate: forceRecreate,
      });

      if (!ok) {
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
      const { ok, error: failure, data } = await useBackend().compose.logs(project, tail);
      if (!ok) {
        return { output: '', error: failure };
      }
      return { output: data.output || '', error: data.error || undefined };
    } catch (e) {
      return { output: '', error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function importFromComposePlugin(): Promise<ComposeImportResult> {
    loading.value = true;
    error.value = null;

    try {
      const { ok, error: failure, data } = await useBackend().compose.importStacks({});

      if (!ok) {
        throw new Error(failure);
      }

      const result = data as unknown as ComposeImportResult;

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
      const { ok, data } = await useBackend().compose.create({
        project_name: projectName,
        compose_content: composeContent,
        env_content: envContent,
      });
      if (!ok) {
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
      const { data } = await useBackend().compose.fileVersions(project, fileType);
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
      const { ok, data } = await useBackend().compose.fileVersion(project, versionId);
      if (!ok) {
        return { version: null, error: data.message };
      }
      return { version: data.version ?? null };
    } catch (e) {
      return { version: null, error: e instanceof Error ? e.message : 'Unknown error' };
    }
  }

  async function restoreFileVersion(project: string, versionId: number): Promise<boolean> {
    try {
      const { ok } = await useBackend().compose.restoreVersion(project, { version_id: versionId });
      return ok;
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
    composeActionsDisabled,
    composeDisabledReason,

    // Actions
    fetchStatus,
    fetchStacks,
    installBinary,
    createStack,
    stackUp,
    stackDown,
    stackStop,
    stackRestart,
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
