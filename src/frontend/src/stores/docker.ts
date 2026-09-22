/**
 * Docker Store - Manages container state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useFolderStore } from './folders';
import { useSettingsStore } from './settings';
import { apiFetch } from '@/utils/csrf';
import { sortByMode } from '@/utils/sortMode';

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

/**
 * The host ports a container holds right now.
 *
 * `hostPorts` comes from the backend's inspect cache, which skips a binding
 * with no fixed host port (`-p 80` or `-P`). Docker picks a new port for those
 * on every start, and that cache never expires, so storing one would go stale.
 * A running container reports the port Docker picked in the list response's
 * `ports[].PublicPort`, so it is read live here instead.
 */
export function heldBindings(c: Container): HostPortBinding[] {
  const held = [...(c.hostPorts ?? [])];
  if (c.state !== 'running') return held;
  for (const p of c.ports ?? []) {
    if (!p.PublicPort) continue;
    const type = (p.Type || 'tcp').toLowerCase();
    // Docker lists a port once per address family, and a fixed binding is
    // already in hostPorts. One entry per port and protocol is enough.
    if (held.some((b) => b.hostPort === p.PublicPort && b.type === type)) continue;
    held.push({ hostIp: p.IP ?? '', hostPort: p.PublicPort, containerPort: p.PrivatePort, type });
  }
  return held;
}

export interface ConflictDetail {
  hostPort: number;
  type: string;
  hostIp: string;
  heldBy: string[]; // names of running containers holding this port
}

export interface SecurityDismissal {
  container_name: string;
  finding_type: string;
}

export interface ConflictInfo {
  conflicts: ConflictDetail[];
}

export interface PullRequest {
  image: string;
  name: string;
  managed: string | null;
  id: string;
  force?: boolean;
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
  /** HostConfig.NetworkMode, e.g. 'bridge', 'host', 'container:<id>'. */
  networkMode: string;
  privileged: boolean;
  capAdd: string[];
  /** Config.ExposedPorts keys, in Docker's own "8989/tcp" form. */
  exposedPorts: string[];
  /**
   * Config.User. Empty on most containers. A value can come from the image's
   * own USER rather than from an override, so it only means somebody chose the
   * user when it differs from `imageUser`.
   */
  user: string;
  /**
   * Config.User of the image the container was built from, empty when the
   * image declares none. Carried so `user` can be read as an override.
   */
  imageUser: string;
  /**
   * PUID and PGID from Config.Env, empty when the container does not set them.
   * On Unraid these, not `user`, decide who owns the files a container writes.
   */
  puid: string;
  pgid: string;
  /**
   * UMASK from Config.Env. Decides the mode of every file the container
   * creates, so it decides whether puid and pgid actually keep anyone out.
   * Empty means the image never overrode the default.
   */
  umask: string;
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
  /**
   * Security findings the user accepted, as sent with the container list.
   * Held here rather than fetched separately so the security store converges
   * on every refresh path without a second request.
   */
  const securityDismissals = ref<SecurityDismissal[]>([]);
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

  // Host port -> name of a container that binds it, over *every* container.
  // Deliberately wider than the `occupied` set inside portConflicts below,
  // which only counts running containers because that is what a conflict means.
  // The security advisor suggests a port to move to, and a stopped container
  // still owns its binding, so suggesting its port would collide on next start.
  const boundHostPorts = computed<Map<number, string>>(() => {
    const owners = new Map<number, string>();
    for (const c of containers.value) {
      for (const b of heldBindings(c)) {
        if (!owners.has(b.hostPort)) owners.set(b.hostPort, c.name);
      }
    }
    return owners;
  });

  // A non-running container has a port conflict when one of its configured
  // host port bindings collides with a binding held by a running container
  // (same port + protocol, with overlapping host IP). The map is keyed by
  // container id and only contains containers that actually conflict.
  const portConflicts = computed<Map<string, ConflictInfo>>(() => {
    // Occupied bindings from running containers.
    const occupied: Array<{ port: number; type: string; ip: string; name: string }> = [];
    for (const c of containers.value) {
      if (c.state !== 'running') continue;
      for (const b of heldBindings(c)) {
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
    // Membership is keyed on name (stable across recreations); the folder
    // store owns the one map of it.
    const folderStore = useFolderStore();
    const settingsStore = useSettingsStore();
    const assigned = folderStore.folderByContainerName;
    const unfoldered = sortedContainers.value.filter((c) => !assigned.has(c.name));

    if (settingsStore.sortMode !== 'manual') {
      return sortByMode(unfoldered, settingsStore.sortMode, (c) => ({
        position: 0,
        name: c.name,
        state: c.state,
        created: c.created,
      }));
    }

    // Manual: saved order first; unplaced containers keep the state-first
    // default after it. A folder member is never listed even if its name is ranked.
    const rank = new Map<string, number>();
    folderStore.unfolderedOrder.forEach((name, i) => {
      if (!rank.has(name)) rank.set(name, i);
    });
    if (rank.size === 0) return unfoldered;

    const ranked = unfoldered
      .filter((c) => rank.has(c.name))
      .sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);
    const unranked = unfoldered.filter((c) => !rank.has(c.name));
    return [...ranked, ...unranked];
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
        // The server says why when it can, for example "Cannot reach Docker".
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      containers.value = data.containers || [];
      securityDismissals.value = data.dismissals || [];
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

  async function resumeContainer(id: string): Promise<boolean> {
    try {
      const response = await apiFetch(`${API_BASE}/containers.php?action=resume&id=${id}`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to resume container`);
      }

      // Refresh container list
      await fetchContainers();

      return true;
    } catch (e) {
      console.error('Error resuming container:', e);
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
    boundHostPorts,
    securityDismissals,

    // Actions
    fetchContainers,
    startContainer,
    resumeContainer,
    stopContainer,
    restartContainer,
    removeContainer,
    toggleAutostart,
  };
});
