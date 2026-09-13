/**
 * Folder Store - Manages folder state and operations
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type {
  Folder,
  FolderCreateData,
  FolderUpdateData,
  FolderContainerSelection,
  FolderExportConfig,
  FolderImportResult,
} from '@/types/folder';
import { apiFetch } from '@/utils/csrf';
import { useSettingsStore } from '@/stores/settings';
import { sortByMode } from '@/utils/sortMode';

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useFolderStore = defineStore('folders', () => {
  // State
  const folders = ref<Folder[]>([]);
  // Manual drag order of the containers that are in no folder, by name.
  const unfolderedOrder = ref<string[]>([]);
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
    const settingsStore = useSettingsStore();
    return sortByMode(folders.value, settingsStore.sortMode, (f) => ({
      position: f.position,
      name: f.name,
      created: f.created_at,
    }));
  });

  // Membership is keyed on container name, the stable key across recreates.
  // Built once per folders change, so a lookup from every card is one map get.
  const folderByContainerName = computed(() => {
    const map = new Map<string, Folder>();
    for (const folder of folders.value) {
      for (const assoc of folder.containers) {
        map.set(assoc.container_name, folder);
      }
    }
    return map;
  });

  const getFolderForContainer = computed(() => {
    return (containerName: string) => folderByContainerName.value.get(containerName);
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
      unfolderedOrder.value = Array.isArray(data.unfoldered_order) ? data.unfoldered_order : [];
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

  /**
   * Put a container in `folderId`, or in no folder when null. Drag and drop and
   * the menu picker both go through here. The forced refetch is needed because
   * addContainerToFolder only swaps the target folder into state while the
   * backend also drops the row from the source folder.
   */
  async function moveContainerToFolder(
    folderId: number | null,
    containerId: string,
    containerName: string,
  ): Promise<boolean> {
    const ok =
      folderId === null
        ? await removeContainerFromFolder(containerName)
        : await addContainerToFolder(folderId, containerId, containerName);
    await fetchFolders(true);
    return ok;
  }

  /**
   * Make a folder's membership match `desired`, issuing only the add and remove
   * calls for containers that actually changed.
   *
   * Re-adding a container that is already in the folder is not free: the backend
   * deletes the row and reinserts it at MAX(position) + 1, so replacing the whole
   * set renumbers every container into the caller's iteration order.
   *
   * The diff is keyed on container_name — that is the association's unique key,
   * and container ids change whenever a container is recreated.
   */
  async function setFolderContainers(
    folderId: number,
    desired: FolderContainerSelection[],
  ): Promise<boolean> {
    const folder = folders.value.find((f) => f.id === folderId);
    if (!folder) return false;

    // Snapshot before mutating: removeContainerFromFolder optimistically splices
    // folder.containers, so reading it lazily would corrupt the diff mid-loop.
    const existingNames = new Set((folder.containers ?? []).map((c) => c.container_name));

    const seen = new Set<string>();
    const desiredList = desired.filter((c) => c.name && !seen.has(c.name) && seen.add(c.name));
    const desiredNames = new Set(desiredList.map((c) => c.name));

    const toRemove = [...existingNames].filter((n) => !desiredNames.has(n));
    const toAdd = desiredList.filter((c) => !existingNames.has(c.name));

    if (toAdd.length === 0 && toRemove.length === 0) return true;

    // Sequential, removals first: each add reads MAX(position) server-side, so
    // concurrent adds would collide on position, and removing first keeps a
    // container moved out and back within one save off the UNIQUE constraint.
    let ok = true;
    for (const name of toRemove) {
      ok = (await removeContainerFromFolder(name)) && ok;
    }
    for (const c of toAdd) {
      ok = (await addContainerToFolder(folderId, c.id, c.name)) && ok;
    }

    await fetchFolders(true);
    return ok;
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

  /**
   * Save the manual order of the unfoldered list. The whole list is sent in
   * display order; the backend replaces the saved order with it.
   */
  async function reorderUnfoldered(containerNames: string[]): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/folders.php?action=reorder_unfoldered`, {
        method: 'POST',
        body: JSON.stringify({
          container_names: containerNames,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to reorder unfoldered containers`);
      }

      const result = await response.json();
      unfolderedOrder.value = Array.isArray(result.unfoldered_order) ? result.unfoldered_order : containerNames;

      return true;
    } catch (e) {
      console.error('Error reordering unfoldered containers:', e);
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
    unfolderedOrder,
    loading,
    error,

    // Getters
    folderCount,
    getFolderById,
    sortedFolders,
    folderByContainerName,
    getFolderForContainer,

    // Actions
    fetchFolders,
    createFolder,
    updateFolder,
    deleteFolder,
    addContainerToFolder,
    removeContainerFromFolder,
    moveContainerToFolder,
    setFolderContainers,
    reorderContainers,
    reorderUnfoldered,
    reorderFolders,
    exportConfiguration,
    importConfiguration,
    toggleFolderCollapse,
  };
});
