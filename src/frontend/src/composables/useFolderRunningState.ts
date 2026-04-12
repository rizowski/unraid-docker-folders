import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { useDockerStore } from '@/stores/docker';
import type { Folder } from '@/types/folder';

/**
 * Derive a folder's running state from actual docker container states.
 * Avoids compose_stacks.services_running which can be stale after up/down.
 */
export function useFolderRunningState(folder: MaybeRefOrGetter<Folder | undefined | null>) {
  const dockerStore = useDockerStore();

  const existingContainers = computed(() => {
    const f = toValue(folder);
    if (!f) return [];
    const map = dockerStore.containersByName;
    const result = [];
    for (const assoc of f.containers) {
      const c = map.get(assoc.container_name);
      if (c) result.push(c);
    }
    return result;
  });

  const runningCount = computed(
    () => existingContainers.value.filter((c) => c.state === 'running').length,
  );
  const totalCount = computed(() => existingContainers.value.length);
  const isRunning = computed(() => runningCount.value > 0);
  const isFullyRunning = computed(
    () => totalCount.value > 0 && runningCount.value >= totalCount.value,
  );

  return { existingContainers, runningCount, totalCount, isRunning, isFullyRunning };
}
