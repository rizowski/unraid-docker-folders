/**
 * Docker Store - Manages container state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFolderStore } from './folders';
import { apiFetch } from '@/utils/csrf';

export interface ContainerPort {
  IP: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface ContainerMount {
  Source: string;
  Destination: string;
  Type: string;
  RW: boolean;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: ContainerPort[];
  mounts: ContainerMount[];
  networkSettings: Record<string, { IPAddress: string }>;
  created: number;
  icon: string | null;
  managed: string | null;
  webui: string | null;
  labels: Record<string, string>;
}

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useDockerStore = defineStore('docker', () => {
  // State
  const containers = ref<Container[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let lastFetchTime = 0;
  const FETCH_DEBOUNCE_MS = 500;
  let initialLoadDone = false;

  // Getters
  const containerCount = computed(() => containers.value.length);

  const getContainerById = computed(() => {
    return (id: string) => containers.value.find((c) => c.id === id);
  });

  const stateOrder: Record<string, number> = {
    exited: 0,
    running: 1,
    created: 2,
  };

  const sortedContainers = computed(() => {
    return [...containers.value].sort((a, b) => {
      return (stateOrder[a.state] ?? 3) - (stateOrder[b.state] ?? 3);
    });
  });

  const unfolderedContainers = computed(() => {
    const folderStore = useFolderStore();
    const assignedContainerNames = new Set<string>();

    // Collect all assigned container names (stable across recreations)
    folderStore.folders.forEach((folder) => {
      folder.containers.forEach((assoc) => {
        assignedContainerNames.add(assoc.container_name);
      });
    });

    // Return containers that aren't in any folder, sorted by state
    return sortedContainers.value.filter((c) => !assignedContainerNames.has(c.name));
  });

  // Actions
  async function fetchContainers(force = false) {
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
      const response = await fetch(`${API_BASE}/containers.php`);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      containers.value = data.containers || [];
      initialLoadDone = true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Unknown error';
      console.error('Error fetching containers:', e);
    } finally {
      loading.value = false;
    }
  }

  async function startContainer(id: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/containers.php?action=start&id=${id}`, {
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
      const response = await apiFetch(`${API_BASE}/containers.php?action=stop&id=${id}`, {
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
      const response = await apiFetch(`${API_BASE}/containers.php?action=restart&id=${id}`, {
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
      const response = await apiFetch(`${API_BASE}/containers.php?action=remove&id=${id}`, {
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
    sortedContainers,
    unfolderedContainers,

    // Actions
    fetchContainers,
    startContainer,
    stopContainer,
    restartContainer,
    removeContainer,
  };
});
