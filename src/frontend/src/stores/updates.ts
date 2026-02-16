/**
 * Updates Store - Manages image update check state
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { apiFetch } from '@/utils/csrf';

export interface ImageUpdateStatus {
  image: string;
  local_digest: string | null;
  remote_digest: string | null;
  update_available: boolean;
  checked_at: number;
  error: string | null;
}

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

export const useUpdatesStore = defineStore('updates', () => {
  const updates = ref<Record<string, ImageUpdateStatus>>({});
  const checking = ref(false);
  const lastChecked = ref<number | null>(null);

  const updatesAvailableCount = computed(() => {
    return Object.values(updates.value).filter((u) => u.update_available).length;
  });

  function hasUpdate(imageName: string): boolean {
    return updates.value[imageName]?.update_available ?? false;
  }

  async function fetchCachedUpdates() {
    try {
      const response = await fetch(`${API_BASE}/updates.php`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      updates.value = data.updates || {};

      // Set lastChecked from most recent check
      const times = Object.values(updates.value).map((u) => u.checked_at).filter(Boolean);
      if (times.length > 0) {
        lastChecked.value = Math.max(...times);
      }
    } catch (e) {
      console.error('Error fetching cached updates:', e);
    }
  }

  async function checkForUpdates() {
    checking.value = true;
    try {
      const response = await apiFetch(`${API_BASE}/updates.php?action=check`, {
        method: 'POST',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      updates.value = data.updates || {};
      lastChecked.value = Math.floor(Date.now() / 1000);
    } catch (e) {
      console.error('Error checking for updates:', e);
    } finally {
      checking.value = false;
    }
  }

  function clearUpdateForImage(imageName: string) {
    if (updates.value[imageName]) {
      updates.value[imageName] = { ...updates.value[imageName], update_available: false };
    }
  }

  return {
    updates,
    checking,
    lastChecked,
    updatesAvailableCount,
    hasUpdate,
    fetchCachedUpdates,
    checkForUpdates,
    clearUpdateForImage,
  };
});
