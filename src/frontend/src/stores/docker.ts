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

export interface HostPortBinding {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  type: string; // 'tcp' | 'udp'
}

export interface ConflictDetail {
  hostPort: number;
  type: string;
  hostIp: string;
  heldBy: string[]; // names of running containers holding this port
}

export interface ConflictInfo {
  conflicts: ConflictDetail[];
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  command: string;
  ports: ContainerPort[];
  hostPorts: HostPortBinding[];
  mounts: ContainerMount[];
  networkSettings: Record<string, { IPAddress: string }>;
  created: number;
  icon: string | null;
  managed: string | null;
  webui: string | null;
  labels: Record<string, string>;
  autostart: boolean;
  autostartDelay: number;
}

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useDockerStore = defineStore('docker', () => {
  // State
  const containers = ref<Container[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const searchQuery = ref('');
  let lastFetchTime = 0;
  const FETCH_DEBOUNCE_MS = 500;
  let initialLoadDone = false;

  // Getters
  const containerCount = computed(() => containers.value.length);

  const getContainerById = computed(() => {
    return (id: string) => containers.value.find((c) => c.id === id);
  });

  const containersByName = computed(() => {
    const map = new Map<string, Container>();
    for (const c of containers.value) map.set(c.name, c);
    return map;
  });

  // Treat unspecified / all-interfaces bindings as a wildcard that overlaps
  // any other host IP on the same port/protocol.
  const isWildcardIp = (ip: string) => ip === '' || ip === '0.0.0.0' || ip === '::';

  // A non-running container has a port conflict when one of its configured
  // host port bindings collides with a binding held by a running container
  // (same port + protocol, with overlapping host IP). The map is keyed by
  // container id and only contains containers that actually conflict.
  const portConflicts = computed<Map<string, ConflictInfo>>(() => {
    // Occupied bindings from running containers.
    const occupied: Array<{ port: number; type: string; ip: string; name: string }> = [];
    for (const c of containers.value) {
      if (c.state !== 'running') continue;
      for (const b of c.hostPorts ?? []) {
        occupied.push({ port: b.hostPort, type: b.type, ip: b.hostIp, name: c.name });
      }
    }

    const result = new Map<string, ConflictInfo>();
    if (occupied.length === 0) return result;

    for (const c of containers.value) {
      if (c.state === 'running') continue;
      const conflicts: ConflictDetail[] = [];

      for (const b of c.hostPorts ?? []) {
        const heldBy = new Set<string>();
        for (const o of occupied) {
          if (o.port !== b.hostPort || o.type !== b.type) continue;
          if (isWildcardIp(b.hostIp) || isWildcardIp(o.ip) || o.ip === b.hostIp) {
            heldBy.add(o.name);
          }
        }
        if (heldBy.size > 0) {
          conflicts.push({
            hostPort: b.hostPort,
            type: b.type,
            hostIp: b.hostIp,
            heldBy: [...heldBy],
          });
        }
      }

      if (conflicts.length > 0) {
        result.set(c.id, { conflicts });
      }
    }

    return result;
  });

  const getPortConflict = computed(() => {
    return (id: string) => portConflicts.value.get(id) ?? null;
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
      const response = await apiFetch(`${API_BASE}/containers.php`);

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

  async function removeContainer(id: string, removeImage = false): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/containers.php?action=remove&id=${id}`, {
        method: 'POST',
        body: removeImage ? JSON.stringify({ remove_image: true }) : undefined,
      });

      if (!response.ok) {
        throw new Error(`Failed to remove container`);
      }

      // Refresh containers and folders (backend cleans up associations)
      const { useFolderStore } = await import('./folders');
      await Promise.all([fetchContainers(), useFolderStore().fetchFolders()]);

      return true;
    } catch (e) {
      console.error('Error removing container:', e);
      return false;
    }
  }

  async function toggleAutostart(name: string, enabled: boolean, delay?: number): Promise<boolean> {
    try {
      const body: Record<string, unknown> = { enabled };
      if (delay !== undefined) body.delay = delay;
      const response = await apiFetch(
        `${API_BASE}/containers.php?action=autostart&name=${encodeURIComponent(name)}`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (!response.ok) {
        throw new Error('Failed to update autostart');
      }
      // Update local state immediately
      const container = containers.value.find(c => c.name === name);
      if (container) {
        container.autostart = enabled;
        if (delay !== undefined) container.autostartDelay = delay;
      }
      return true;
    } catch (e) {
      console.error('Error toggling autostart:', e);
      return false;
    }
  }

  return {
    // State
    containers,
    loading,
    error,
    searchQuery,

    // Getters
    containerCount,
    getContainerById,
    containersByName,
    sortedContainers,
    unfolderedContainers,
    portConflicts,
    getPortConflict,

    // Actions
    fetchContainers,
    startContainer,
    stopContainer,
    restartContainer,
    removeContainer,
    toggleAutostart,
  };
});
