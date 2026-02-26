import { computed, onMounted, onUnmounted, watch, toValue, type MaybeRefOrGetter } from 'vue';
import { useStatsStore, type ContainerStats } from '@/stores/stats';
import { useSettingsStore } from '@/stores/settings';

export function useContainerStats(opts: {
  containerId: MaybeRefOrGetter<string>;
  isRunning: MaybeRefOrGetter<boolean>;
  expanded: MaybeRefOrGetter<boolean>;
}) {
  const statsStore = useStatsStore();
  const settingsStore = useSettingsStore();

  const showStats = computed(() => settingsStore.showStats);
  const containerStats = computed((): ContainerStats | null =>
    showStats.value ? statsStore.getStats(toValue(opts.containerId)) : null,
  );

  onMounted(() => {
    if (showStats.value && toValue(opts.isRunning)) {
      statsStore.registerVisible(toValue(opts.containerId));
    }
  });

  watch(
    () => toValue(opts.isRunning),
    (running) => {
      if (!showStats.value) return;
      if (running) {
        statsStore.registerVisible(toValue(opts.containerId));
      } else {
        statsStore.unregisterVisible(toValue(opts.containerId));
      }
    },
  );

  watch(showStats, (enabled) => {
    if (enabled) {
      if (toValue(opts.isRunning)) statsStore.registerVisible(toValue(opts.containerId));
      if (toValue(opts.expanded)) statsStore.registerExpanded(toValue(opts.containerId));
    } else {
      statsStore.unregisterVisible(toValue(opts.containerId));
      statsStore.unregisterExpanded(toValue(opts.containerId));
    }
  });

  watch(
    () => toValue(opts.expanded),
    (val) => {
      if (!showStats.value) return;
      if (val) {
        statsStore.registerExpanded(toValue(opts.containerId));
      } else {
        statsStore.unregisterExpanded(toValue(opts.containerId));
      }
    },
  );

  onUnmounted(() => {
    statsStore.unregisterVisible(toValue(opts.containerId));
    if (toValue(opts.expanded)) {
      statsStore.unregisterExpanded(toValue(opts.containerId));
    }
  });

  return { showStats, containerStats };
}
