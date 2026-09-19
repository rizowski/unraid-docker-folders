<template>
  <div class="widget-row flex items-center gap-2 py-1 pl-2 pr-1 min-w-0" :class="{ 'opacity-60': busy }">
    <ContainerIcon
      v-if="showIcon"
      :src="container.icon || fallbackIcon"
      :alt="container.name"
      :halo-class="status.halo"
      :status-tooltip="status.tooltip"
      :href="null"
    />
    <span v-else class="inline-block size-2 rounded-full shrink-0 bg-(--halo-color)" :class="status.halo" :title="status.tooltip" />
    <!-- Name and tags share one column, so the tags wrap under the name instead
         of squeezing it. -->
    <span class="flex-1 min-w-0 flex flex-col items-start">
      <span class="max-w-full text-sm text-text truncate" :title="container.name">{{ container.name }}</span>
      <span v-if="showTags && hasTags" class="flex flex-wrap items-center gap-1 mt-0.5">
        <a
          v-if="hasUpdate && releaseNotesUrl"
          :href="releaseNotesUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning hover:bg-warning/30"
          title="View release notes"
        >Update</a>
        <span v-else-if="hasUpdate" class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning">Update</span>
        <span
          v-if="restartCount >= RESTART_TAG_MIN"
          class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold font-mono rounded bg-error/15 text-error"
          :title="`${restartCount} restarts`"
        >{{ restartCount }} rst</span>
        <span
          v-if="failedSchedules.length"
          class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-error/15 text-error"
          :title="failedTitle"
        >Failed</span>
      </span>
    </span>
    <span v-if="showStats && isRunning" class="shrink-0 flex gap-1.5 text-xs font-mono" :title="statsTitle">
      <span v-for="part in statParts" :key="part.key" class="widget-stat flex flex-col w-10">
        <span class="text-right leading-tight" :class="loadClass(part.percent)">{{ part.percent === undefined ? '--' : formatPercent(part.percent) }}</span>
        <span class="h-0.5 stats-bar-track rounded-full overflow-hidden">
          <span
            v-if="part.percent !== undefined"
            class="block h-full rounded-full transition-all duration-300"
            :class="LOAD_BAR_CLASSES[loadLevel(part.percent)]"
            :style="{ width: Math.min(part.percent, 100) + '%' }"
          />
        </span>
      </span>
    </span>
    <a
      v-if="webuiUrl"
      :href="webuiUrl"
      target="_blank"
      rel="noopener"
      class="icon-btn shrink-0 text-text-secondary hover:text-text"
      :title="`Open WebUI for ${container.name}`"
    ><IconGlobe :size="14" /></a>
    <svg
      v-if="busy"
      class="animate-spin h-3.5 w-3.5 shrink-0 text-text-secondary"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-label="Working"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
    </svg>
    <KebabMenu
      :items="menuItems"
      :fit-viewport="false"
      :icon-size="14"
      button-class="icon-btn text-text-secondary hover:text-text"
      :button-title="`Actions for ${container.name}`"
      @select="onSelect"
      @open-change="(open, bottom) => emit('menu-open-change', open, bottom)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import ContainerIcon from '@/components/docker/ContainerIcon.vue';
import IconGlobe from '@/components/icons/IconGlobe.vue';
import KebabMenu, { type KebabMenuItem } from '@/components/KebabMenu.vue';
import { useDockerStore, type Container } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { useUpdatesStore } from '@/stores/updates';
import type { Schedule } from '@/types/schedule';
import { containerEditUrl, containerStatus, containerWebuiUrl, openContainerTerminal } from '@/utils/containerDisplay';
import { formatBytes, formatPercent, loadLevel, LOAD_BAR_CLASSES } from '@/utils/format';
import { releaseIndexUrl } from '@/utils/updateUnits';

/** One or two restarts are often a deliberate restart. Three or more point at a restart loop. */
const RESTART_TAG_MIN = 3;
const LOAD_TEXT_CLASSES = { high: 'text-error', medium: 'text-warning', low: 'text-text-secondary' } as const;

const props = defineProps<{
  container: Container;
  distinguishHealthy: boolean;
  showIcon: boolean;
  showWebui: boolean;
  showStats: boolean;
  showTags: boolean;
  /** Enabled schedules for this container or its stack whose last run failed. */
  failedSchedules: Schedule[];
}>();

const emit = defineEmits<{
  'menu-open-change': [open: boolean, bottom: number];
}>();

const dockerStore = useDockerStore();
const settingsStore = useSettingsStore();
const statsStore = useStatsStore();
const updatesStore = useUpdatesStore();
const fallbackIcon = `${import.meta.env.BASE_URL}docker.svg`;

const busy = ref(false);

const status = computed(() => containerStatus(props.container, props.distinguishHealthy));
const isRunning = computed(() => props.container.state === 'running');
const isPaused = computed(() => props.container.state === 'paused');
const isCompose = computed(() => !!props.container.labels?.['com.docker.compose.project']);
const editUrl = computed(() => containerEditUrl(props.container));
// Only while running, the same rule as the Folders page card: a stopped container serves no page.
const webuiUrl = computed(() => (props.showWebui && isRunning.value ? containerWebuiUrl(props.container) : null));

// Registered here, not through useContainerStats: that composable follows the
// Folders page stats setting, and the widget has its own. A collapsed folder
// unmounts its rows, so its containers stop polling.
watch(
  () => props.showStats && isRunning.value,
  (on) => (on ? statsStore.registerVisible(props.container.id) : statsStore.unregisterVisible(props.container.id)),
  { immediate: true },
);
onUnmounted(() => statsStore.unregisterVisible(props.container.id));

const stats = computed(() => (props.showStats ? statsStore.getStats(props.container.id) : null));
const restartCount = computed(() => stats.value?.restartCount ?? 0);
const statsTitle = computed(() =>
  stats.value
    ? `CPU ${formatPercent(stats.value.cpuPercent)} · Memory ${formatBytes(stats.value.memoryUsage)} / ${formatBytes(stats.value.memoryLimit)}`
    : 'Loading stats',
);
// Named, and computed rather than built in the template, so a rerender that
// does not touch the stats does not rebuild the pair.
const statParts = computed(() => [
  { key: 'cpu', percent: stats.value?.cpuPercent },
  { key: 'memory', percent: stats.value?.memoryPercent },
]);
function loadClass(percent: number | undefined): string {
  return percent === undefined ? 'text-text-secondary' : LOAD_TEXT_CLASSES[loadLevel(percent)];
}

const hasUpdate = computed(() => settingsStore.enableUpdateChecks && updatesStore.hasUpdate(props.container.image));
const releaseNotesUrl = computed(() => releaseIndexUrl(updatesStore.updates[props.container.image]));
const hasTags = computed(
  () => hasUpdate.value || restartCount.value >= RESTART_TAG_MIN || props.failedSchedules.length > 0,
);
const failedTitle = computed(() =>
  props.failedSchedules.map((s) => `${s.name}: ${s.last_run_message || 'failed'}`).join('\n'),
);

const menuItems = computed<KebabMenuItem[]>(() => [
  { label: 'Start', icon: 'M6 4l14 8-14 8z', action: 'start', class: 'text-success', show: !isRunning.value && !isPaused.value, disabled: busy.value },
  { label: 'Resume', icon: 'M6 4l14 8-14 8z', action: 'resume', class: 'text-success', show: isPaused.value, disabled: busy.value },
  { label: 'Stop', icon: 'M6 6h12v12H6z', action: 'stop', class: 'text-error', show: isRunning.value, disabled: busy.value },
  // `href` is empty for an unmanaged container, so KebabMenu falls through to
  // its button branch, which is the only one that honours disabled/title.
  {
    label: 'Edit',
    icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
    href: editUrl.value || '',
    disabled: !editUrl.value,
    title: editUrl.value ? undefined : 'Only available for containers that Unraid manages.',
  },
  { label: 'Logs', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8', action: 'logs', show: !isCompose.value },
]);

async function run(action: (id: string) => Promise<boolean>) {
  busy.value = true;
  try {
    await action(props.container.id);
  } finally {
    busy.value = false;
  }
}

function onSelect(action: string) {
  if (action === 'start') void run(dockerStore.startContainer);
  else if (action === 'resume') void run(dockerStore.resumeContainer);
  else if (action === 'stop') void run(dockerStore.stopContainer);
  else if (action === 'logs') openContainerTerminal(props.container.name, 'logs');
}
</script>
