/**
 * Folder Store - Manages folder state and operations
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Folder, FolderCreateData, FolderUpdateData, FolderExportConfig, FolderImportResult } from '@/types/folder';
import { apiFetch } from '@/utils/csrf';

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useFolderStore = defineStore('folders', () => {
  // State
  const folders = ref<Folder[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let lastFetchTime = 0;
  const FETCH_DEBOUNCE_MS = 500;
  let initialLoadDone = false;

  // Getters
  const folderCount = computed(() => folders.value.length);

  const getFolderById = computed(() => {
    return (id: number) => folders.value.find((f) => f.id === id);
  });

  const sortedFolders = computed(() => {
    return [...folders.value].sort((a, b) => a.position - b.position);
  });

  // Actions
  async function fetchFolders(force = false) {
    const now = Date.now();
    if (!force && now - lastFetchTime < FETCH_DEBOUNCE_MS) {
      return;
    }
    lastFetchTime = now;

    // Only show loading spinner on initial load
    if (!initialLoadDone) {
      loading.value = true;
    }
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/folders.php`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      folders.value = data.folders || [];
      initialLoadDone = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error fetching folders:', e);
    } finally {
      loading.value = false;
    }
  }

  async function createFolder(data: FolderCreateData): Promise<Folder | null> {
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/folders.php`, {
        method: 'POST',
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`Failed to create folder`);
      }

      const result = await response.json();
      const newFolder = result.folder;

      // Add to local state
      folders.value.push(newFolder);

      return newFolder;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error creating folder:', e);
      return null;
    }
  }

  async function updateFolder(id: number, data: FolderUpdateData): Promise<boolean> {
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/folders.php?id=${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`Failed to update folder`);
      }

      const result = await response.json();
      const updatedFolder = result.folder;

      // Update local state
      const index = folders.value.findIndex((f) => f.id === id);
      if (index !== -1) {
        folders.value[index] = updatedFolder;
      }

      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error updating folder:', e);
      return false;
    }
  }

  async function deleteFolder(id: number): Promise<boolean> {
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/folders.php?id=${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`Failed to delete folder`);
      }

      // Remove from local state
      folders.value = folders.value.filter((f) => f.id !== id);

      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error deleting folder:', e);
      return false;
    }
  }

  async function addContainerToFolder(folderId: number, containerId: string, containerName: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/folders.php?id=${folderId}&action=add_container`, {
        method: 'POST',
        body: JSON.stringify({
          container_id: containerId,
          container_name: containerName,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to add container to folder`);
      }

      const result = await response.json();
      const updatedFolder = result.folder;

      // Update local state
      const index = folders.value.findIndex((f) => f.id === folderId);
      if (index !== -1) {
        folders.value[index] = updatedFolder;
      }

      return true;
    } catch (e) {
      console.error('Error adding container to folder:', e);
      return false;
    }
  }

  async function removeContainerFromFolder(containerName: string): Promise<boolean> {
    // Optimistically remove from local state
    for (const folder of folders.value) {
      folder.containers = folder.containers.filter((c) => c.container_name !== containerName);
    }

    try {
      const response = await apiFetch(`${API_BASE}/folders.php?action=remove_container`, {
        method: 'POST',
        body: JSON.stringify({
          container_name: containerName,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to remove container from folder`);
      }

      return true;
    } catch (e) {
      console.error('Error removing container from folder:', e);
      // Refresh to restore correct state on error
      await fetchFolders(true);
      return false;
    }
  }

  async function reorderContainers(folderId: number, containerIds: string[]): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/folders.php?id=${folderId}&action=reorder_containers`, {
        method: 'POST',
        body: JSON.stringify({
          container_ids: containerIds,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to reorder containers`);
      }

      const result = await response.json();
      const updatedFolder = result.folder;

      // Update local state
      const index = folders.value.findIndex((f) => f.id === folderId);
      if (index !== -1) {
        folders.value[index] = updatedFolder;
      }

      return true;
    } catch (e) {
      console.error('Error reordering containers:', e);
      return false;
    }
  }

  async function reorderFolders(folderIds: number[]): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/folders.php?action=reorder_folders`, {
        method: 'POST',
        body: JSON.stringify({
          folder_ids: folderIds,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to reorder folders`);
      }

      // Refresh folders to update positions
      await fetchFolders(true);

      return true;
    } catch (e) {
      console.error('Error reordering folders:', e);
      return false;
    }
  }

  async function exportConfiguration(): Promise<FolderExportConfig | null> {
    try {
      const response = await apiFetch(`${API_BASE}/folders.php?action=export`);

      if (!response.ok) {
        throw new Error(`Failed to export configuration`);
      }

      return await response.json();
    } catch (e) {
      console.error('Error exporting configuration:', e);
      return null;
    }
  }

  async function importConfiguration(config: FolderExportConfig): Promise<FolderImportResult | null> {
    loading.value = true;
    error.value = null;

    try {
      const response = await apiFetch(`${API_BASE}/folders.php?action=import`, {
        method: 'POST',
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error(`Failed to import configuration`);
      }

      const result = await response.json();

      // Refresh folders
      await fetchFolders(true);

      return result;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error importing configuration:', e);
      return null;
    } finally {
      loading.value = false;
    }
  }

  function toggleFolderCollapse(id: number) {
    const folder = folders.value.find((f) => f.id === id);
    if (folder) {
      // Update local state immediately (optimistic)
      folder.collapsed = !folder.collapsed;

      // Persist to backend silently — don't touch loading/error state
      apiFetch(`${API_BASE}/folders.php?id=${id}`, {
        method: 'PUT',
        body: JSON.stringify({ collapsed: folder.collapsed }),
      }).catch((e) => {
        console.error('Error persisting folder collapse:', e);
      });
    }
  }

  return {
    // State
    folders,
    loading,
    error,

    // Getters
    folderCount,
    getFolderById,
    sortedFolders,

    // Actions
    fetchFolders,
    createFolder,
    updateFolder,
    deleteFolder,
    addContainerToFolder,
    removeContainerFromFolder,
    reorderContainers,
    reorderFolders,
    exportConfiguration,
    importConfiguration,
    toggleFolderCollapse,
  };
});
