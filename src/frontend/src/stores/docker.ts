/**
 * Docker Store - Manages container state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFolderStore } from './folders';
import { withCsrf } from '@/utils/csrf';

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useDockerStore = defineStore('docker', () => {
  // State
  const containers = ref<Container[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let lastFetchTime = 0;
  const FETCH_DEBOUNCE_MS = 500;

  // Getters
  const containerCount = computed(() => containers.value.length);

  const getContainerById = computed(() => {
    return (id: string) => containers.value.find((c) => c.id === id);
  });

  const unfolderedContainers = computed(() => {
    const folderStore = useFolderStore();
    const assignedContainerIds = new Set<string>();

    // Collect all assigned container IDs
    folderStore.folders.forEach((folder) => {
      folder.containers.forEach((assoc) => {
        assignedContainerIds.add(assoc.container_id);
      });
    });

    // Return containers that aren't in any folder
    return containers.value.filter((c) => !assignedContainerIds.has(c.id));
  });

  // Actions
  async function fetchContainers(force = false) {
    const now = Date.now();
    if (!force && now - lastFetchTime < FETCH_DEBOUNCE_MS) {
      return;
    }
    lastFetchTime = now;

    loading.value = true;
    error.value = null;

    try {
      const response = await fetch(`${API_BASE}/containers.php`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      containers.value = data.containers || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error fetching containers:', e);
    } finally {
      loading.value = false;
    }
  }

  async function startContainer(id: string): Promise<boolean> {
    try {
      const response = await fetch(withCsrf(`${API_BASE}/containers.php?action=start&id=${id}`), {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to start container`);
      }

      // Refresh container list
      await fetchContainers();

      return true;
    } catch (e) {
      console.error('Error starting container:', e);
      return false;
    }
  }

  async function stopContainer(id: string): Promise<boolean> {
    try {
      const response = await fetch(withCsrf(`${API_BASE}/containers.php?action=stop&id=${id}`), {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to stop container`);
      }

      // Refresh container list
      await fetchContainers();

      return true;
    } catch (e) {
      console.error('Error stopping container:', e);
      return false;
    }
  }

  async function restartContainer(id: string): Promise<boolean> {
    try {
      const response = await fetch(withCsrf(`${API_BASE}/containers.php?action=restart&id=${id}`), {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to restart container`);
      }

      // Refresh container list
      await fetchContainers();

      return true;
    } catch (e) {
      console.error('Error restarting container:', e);
      return false;
    }
  }

  async function removeContainer(id: string): Promise<boolean> {
    try {
      const response = await fetch(withCsrf(`${API_BASE}/containers.php?action=remove&id=${id}`), {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to remove container`);
      }

      // Refresh container list
      await fetchContainers();

      return true;
    } catch (e) {
      console.error('Error removing container:', e);
      return false;
    }
  }

  return {
    // State
    containers,
    loading,
    error,

    // Getters
    containerCount,
    getContainerById,
    unfolderedContainers,

    // Actions
    fetchContainers,
    startContainer,
    stopContainer,
    restartContainer,
    removeContainer,
  };
});
