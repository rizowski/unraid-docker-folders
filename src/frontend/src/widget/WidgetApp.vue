<template>
  <div id="unraid-docker-folders-modern" ref="rootEl" class="unapi font-sans text-text">
    <WidgetSettingsPanel v-if="settingsOpen" :settings="prefs" @change="(key, value) => (prefs = { ...prefs, [key]: value })" @close="settingsOpen = false" />

    <div class="relative mb-2">
      <input
        v-model="query"
        type="text"
        placeholder="Search containers..."
        class="form-input subtle"
        :style="{ paddingRight: query ? '28px' : undefined }"
      />
      <button
        v-if="query"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text cursor-pointer leading-none"
        title="Clear search"
        aria-label="Clear search"
        @click="query = ''"
      >&times;</button>
    </div>

    <div v-if="prefs.showStats && runningIds.length > 0" class="widget-total pb-2 mb-1 border-b border-border" :title="totalTitle">
      <div class="flex items-center justify-between px-2 mb-1 text-xs">
        <span class="font-semibold">All running</span>
        <span class="text-text-secondary">{{ runningIds.length }} {{ runningIds.length === 1 ? 'container' : 'containers' }}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 px-2">
        <WidgetArcGauge label="CPU" :percent="runningTotal?.cpuPercent" :detail="cpuDetail" />
        <WidgetArcGauge label="Memory" :percent="runningTotal?.memPercent" :detail="memoryDetail" />
      </div>
    </div>

    <!-- Placeholder rows shaped like WidgetContainerRow while the first load runs. -->
    <div v-if="isLoading" role="status" aria-busy="true" class="flex flex-col">
      <span class="sr-only">Loading...</span>
      <div v-for="width in SKELETON_NAME_WIDTHS" :key="width" class="flex items-center gap-2 py-1 pl-2 pr-1">
        <span class="skeleton size-6 shrink-0 rounded-full!" />
        <span class="skeleton h-3" :style="{ width }" />
        <span class="flex-1" />
        <template v-if="prefs.showStats">
          <span class="skeleton h-3 w-10" />
          <span class="skeleton h-3 w-10" />
        </template>
      </div>
    </div>
    <p v-else-if="error" class="text-xs text-error py-1">Error: {{ error }}</p>
    <p v-else-if="groups.length === 0" class="text-xs text-text-secondary py-1">
      {{ query ? 'No containers match.' : prefs.hideStopped ? 'No running containers.' : 'No containers.' }}
    </p>

    <div v-else class="flex flex-col">
      <section v-for="group in groups" :key="group.key" class="border-b border-border last:border-b-0">
        <div
          class="relative flex items-center px-2 py-1.5 cursor-pointer select-none hover:bg-bg-card"
          role="button"
          :aria-expanded="isExpanded(group)"
          tabindex="0"
          @click="toggle(group.key)"
          @keydown.enter.prevent="toggle(group.key)"
          @keydown.space.prevent="toggle(group.key)"
        >
          <!-- The same folder-color tint the Folders page header uses (the
               sanctioned gradient in DESIGN.md §2), not a second gradient: full
               strength expanded, faint collapsed. It spans the row rather than
               sitting in a left border, so the two surfaces read alike. The
               content sits in a `relative` wrapper below, because a positioned
               overlay paints over static siblings whatever the DOM order. -->
          <div
            class="absolute inset-0 pointer-events-none transition-opacity duration-200"
            :class="isExpanded(group) ? 'opacity-100' : 'opacity-40'"
            :style="{ background: `linear-gradient(to right, ${groupTint(group)}, transparent)` }"
          ></div>
          <div class="relative flex items-center gap-2 w-full min-w-0">
            <ChevronIcon :expanded="isExpanded(group)" :size="12" />
            <span class="flex-1 min-w-0 text-sm font-semibold truncate">{{ group.name }}</span>
            <template v-if="prefs.showTags">
              <span
                v-if="group.updates > 0"
                class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning"
                :title="`${group.updates} update${group.updates > 1 ? 's' : ''} available`"
              >{{ group.updates }} update{{ group.updates > 1 ? 's' : '' }}</span>
              <span
                v-if="group.failed > 0"
                class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-error/15 text-error"
                :title="`${group.failed} container${group.failed > 1 ? 's' : ''} with a failed scheduled run`"
              >{{ group.failed }} failed</span>
            </template>
            <span
              class="shrink-0 text-xs text-text-secondary"
              :title="`${group.running} running / ${group.total} total`"
            >{{ group.running }}/{{ group.total }}</span>
          </div>
        </div>
        <div v-if="isExpanded(group)" class="pb-1">
          <WidgetContainerRow
            v-for="container in group.containers"
            :key="container.id"
            :container="container"
            :distinguish-healthy="settingsStore.distinguishHealthy"
            :show-icon="prefs.showIcons"
            :show-webui="prefs.showWebui"
            :show-stats="prefs.showStats"
            :show-tags="prefs.showTags"
            :failed-schedules="failedSchedules.get(container.name) ?? NO_SCHEDULES"
            @menu-open-change="onMenuOpenChange"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import ChevronIcon from '@/components/common/ChevronIcon.vue';
import WidgetContainerRow from './WidgetContainerRow.vue';
import WidgetArcGauge from './WidgetArcGauge.vue';
import WidgetSettingsPanel from './WidgetSettings.vue';
import { loadWidgetSettings, saveWidgetSettings } from './widgetSettings';
import { useDockerStore, type Container } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore, type ContainerStats } from '@/stores/stats';
import { useUpdatesStore } from '@/stores/updates';
import { useScheduleStore } from '@/stores/schedules';
import type { Schedule } from '@/types/schedule';
import { initLiveUpdates } from '@/composables/useLiveUpdates';
import { containerMatchesSearch } from '@/utils/search';
import { isAliveContainer } from '@/utils/containerDisplay';
import { composeProjectOf } from '@/utils/updateUnits';
import { effectiveSortMode, sortByMode } from '@/utils/sortMode';
import { reportHeightToParent } from '@/utils/iframeHost';
import { safeLocalStorageGetJson, safeLocalStorageSet } from '@/utils/safeStorage';
import { aggregateStats } from '@/utils/aggregateStats';
import { formatBytes, formatPercent } from '@/utils/format';

/** Slower than the Folders page: the dashboard is often left open for hours. */
const WIDGET_POLL_INTERVAL = 60000;
/**
 * Stats poll slower than the Folders page (5s) for the same reason. PHP mode
 * only: in GraphQL mode the server pushes stats every 2s, as on the Folders page.
 */
const WIDGET_STATS_INTERVAL = 15000;
const NO_SCHEDULES: Schedule[] = [];
const COLLAPSE_KEY = 'docker-folders-widget-collapsed';
const OTHER_KEY = 'other';
/** A group that is not a folder and so carries no color tint. */
const NO_TINT = 'transparent';

interface Group {
  key: string;
  name: string;
  color: string;
  containers: Container[];
  running: number;
  total: number;
  /** Members whose image has an update. */
  updates: number;
  /** Members with a failed scheduled run. */
  failed: number;
}

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const settingsStore = useSettingsStore();
const statsStore = useStatsStore();
const updatesStore = useUpdatesStore();
const scheduleStore = useScheduleStore();
statsStore.setPollInterval(WIDGET_STATS_INTERVAL);

const query = ref('');
const isSearching = computed(() => query.value.trim().length > 0);
const isLoading = computed(() => dockerStore.loading || folderStore.loading);
/** Name bar widths for the loading rows, varied so they do not look stamped. */
const SKELETON_NAME_WIDTHS = ['45%', '30%', '55%', '38%'];
const error = computed(() => dockerStore.error || folderStore.error);

// Enabled schedules whose last run failed, by container name. A stack schedule
// counts for every container in that Compose project. One pass here, so rows
// do not each scan the schedule list.
const failedSchedules = computed(() => {
  const map = new Map<string, Schedule[]>();
  const failed = scheduleStore.schedules.filter((s) => s.enabled && s.last_run_status === 'error');
  if (failed.length === 0) return map;
  for (const c of dockerStore.containers) {
    const project = composeProjectOf(c);
    const mine = failed.filter(
      (s) => (s.target_type === 'container' && s.target_id === c.name) || (s.target_type === 'stack' && !!project && s.target_id === project),
    );
    if (mine.length) map.set(c.name, mine);
  }
  return map;
});

// Folder membership, order, and counts do not depend on the search text, so
// they live in their own computed and a keystroke only reruns the filter below.
const allGroups = computed<Group[]>(() => {
  const byName = dockerStore.containersByName;
  const result: Group[] = [];
  for (const folder of folderStore.sortedFolders) {
    // Same member order as the Folders page, including its sort mode.
    const assocs = sortByMode(folder.containers, effectiveSortMode(folder.sort_mode, settingsStore.sortMode), (assoc) => {
      const c = byName.get(assoc.container_name);
      return { position: assoc.position, name: c?.name ?? assoc.container_name, state: c?.state, created: c?.created };
    });
    const members = assocs.map((assoc) => byName.get(assoc.container_name)).filter((c): c is Container => !!c);
    // Same fallback as FolderHeader.vue, so an uncolored folder tints the same
    // on both surfaces. Other is not a folder and carries no tint at all, which
    // is how the Folders page treats unfoldered containers.
    result.push(makeGroup(`folder-${folder.id}`, folder.name, folder.color || 'var(--header-background, #ff8c2f)', members));
  }
  result.push(makeGroup(OTHER_KEY, 'Other', NO_TINT, dockerStore.unfolderedContainers));
  return result;
});

/**
 * The folder tint from FolderHeader.vue: the folder's own color at 12%.
 *
 * An untinted group returns `transparent` on its own rather than a mix of it.
 * `transparent` is zero-alpha black, so mixing it bets on how srgb handles
 * premultiplied alpha, and a wrong bet paints a dark smudge on a light theme.
 */
function groupTint(group: Group): string {
  return group.color === NO_TINT ? NO_TINT : `color-mix(in srgb, ${group.color} 12%, transparent)`;
}

function makeGroup(key: string, name: string, color: string, members: Container[]): Group {
  const running = members.filter((c) => c.state === 'running').length;
  const checkUpdates = settingsStore.enableUpdateChecks;
  const updates = checkUpdates ? members.filter((c) => updatesStore.hasUpdate(c.image)).length : 0;
  const failed = members.filter((c) => failedSchedules.value.has(c.name)).length;
  return { key, name, color, containers: members, running, total: members.length, updates, failed };
}

const prefs = ref(loadWidgetSettings());
watch(prefs, saveWidgetSettings);
const settingsOpen = ref(false);
// Its own computed, so changing another setting does not rerun the group filter.
const hideStopped = computed(() => prefs.value.hideStopped);

// True while the dashboard tile is folded shut. The page tells the frame, and
// the frame keeps measuring stats then, for the summary in the tile header.
const tileCollapsed = ref(false);
/** Whether stats are measured: shown in the widget, or summed for the folded tile's header. */
const trackStats = computed(() => prefs.value.showStats || tileCollapsed.value);

// Every running container is registered for stats here, not by its row. The
// all-running total needs them all, including those in a collapsed folder, whose
// rows are unmounted. The stats store keeps a plain set of ids, so a row that
// unregistered on unmount would also drop the id from the total.
const runningIds = computed(() => dockerStore.containers.filter((c) => c.state === 'running').map((c) => c.id));
let registeredIds: string[] = [];
function syncRegistered(ids: string[]) {
  const next = new Set(ids);
  for (const id of registeredIds) if (!next.has(id)) statsStore.unregisterVisible(id);
  const prev = new Set(registeredIds);
  for (const id of ids) if (!prev.has(id)) statsStore.registerVisible(id);
  registeredIds = ids;
}
watch(
  () => (trackStats.value ? runningIds.value : []),
  syncRegistered,
  { immediate: true },
);

/** Every running container together, as a share of the host. Null until any stats arrive. */
const runningTotal = computed(() => {
  if (!trackStats.value) return null;
  const list = runningIds.value.map((id) => statsStore.getStats(id)).filter((s): s is ContainerStats => !!s);
  return aggregateStats(list);
});
const cpuDetail = computed(() => {
  const t = runningTotal.value;
  if (!t) return '';
  return t.hostCpus === 1 ? 'of 1 core' : `of ${t.hostCpus} cores`;
});
const memoryDetail = computed(() => {
  const t = runningTotal.value;
  return t ? `${formatBytes(t.memoryUsage)} / ${formatBytes(t.hostMemory)}` : '';
});
const totalTitle = computed(() => {
  const t = runningTotal.value;
  if (!t) return 'Loading stats';
  const cores = t.hostCpus === 1 ? '1 core' : `${t.hostCpus} cores`;
  return `CPU ${formatPercent(t.cpuPercent)} of ${cores} · Memory ${formatBytes(t.memoryUsage)} / ${formatBytes(t.hostMemory)}`;
});

// The cog in the tile header lives in the dashboard page, outside this frame,
// so it asks for the panel with a message. The page also says when the tile
// folds or opens.
function onParentMessage(e: MessageEvent) {
  if (e.source !== window.parent || e.origin !== window.location.origin) return;
  if (e.data?.type === 'docker-folders-widget-settings') settingsOpen.value = !settingsOpen.value;
  if (e.data?.type === 'docker-folders-tile-collapsed') tileCollapsed.value = e.data.collapsed === true;
}

// The folded tile shows only its header row, and the header lives in the
// dashboard page. Send it the totals to draw there. Percents are null until
// stats arrive.
const tileSummary = computed(() => ({
  type: 'docker-folders-summary',
  running: runningIds.value.length,
  total: dockerStore.containers.length,
  cpu: runningTotal.value?.cpuPercent ?? null,
  memory: runningTotal.value?.memPercent ?? null,
}));
watch(tileSummary, (summary) => {
  if (window.parent !== window && !isLoading.value) window.parent.postMessage(summary, window.location.origin);
}, { immediate: true });

// The count in each header stays running/total over every member, so a folder
// keeps showing how much of it is stopped while those rows are hidden.
const groups = computed<Group[]>(() => {
  const q = query.value;
  const searching = isSearching.value;
  const hide = hideStopped.value;
  if (!searching && !hide) return allGroups.value.filter((g) => g.containers.length > 0);
  const shown = (c: Container) => (!hide || isAliveContainer(c)) && (!searching || containerMatchesSearch(q, c.name, c.image));
  return allGroups.value
    .map((g) => ({ ...g, containers: g.containers.filter(shown) }))
    .filter((g) => g.containers.length > 0);
});

// Collapse state is the widget's own, so folding a folder on the dashboard does
// not fold it on the Folders page. A group the user never touched follows the
// "Start folders collapsed" setting.
const savedCollapsed = safeLocalStorageGetJson(COLLAPSE_KEY);
const collapsed = ref<Record<string, boolean>>(
  savedCollapsed && typeof savedCollapsed === 'object' ? (savedCollapsed as Record<string, boolean>) : {},
);
watch(collapsed, (v) => safeLocalStorageSet(COLLAPSE_KEY, JSON.stringify(v)), { deep: true });

function isExpanded(group: Group): boolean {
  if (isSearching.value) return true;
  return !(collapsed.value[group.key] ?? prefs.value.startCollapsed);
}

function toggle(key: string) {
  const group = groups.value.find((g) => g.key === key);
  if (!group) return;
  collapsed.value[key] = isExpanded(group);
}

// An open kebab menu hangs below its row and can run past the end of the
// frame, so hold the frame tall enough to show it until it closes.
const rootEl = ref<HTMLElement | null>(null);
let menuBottom = 0;
let resendHeight: () => void = () => {};

function onMenuOpenChange(_open: boolean, bottom: number) {
  menuBottom = bottom;
  resendHeight();
}

onMounted(async () => {
  window.addEventListener('message', onParentMessage);
  // The app mounts after the backend check, so a fold message the page sent
  // on frame load came too early. Ask for it again now that someone listens.
  if (window.parent !== window) window.parent.postMessage({ type: 'docker-folders-widget-ready' }, window.location.origin);
  if (rootEl.value) resendHeight = reportHeightToParent(rootEl.value, () => menuBottom);
  // Tag data loads after the rows, and only when tags are on. Turning tags on
  // later loads it then (watch below).
  if (prefs.value.showTags) void scheduleStore.fetchSchedules();
  await Promise.all([dockerStore.fetchContainers(), folderStore.fetchFolders(), settingsStore.fetchSettings()]);
  loadUpdates();
  initLiveUpdates({ pollInterval: WIDGET_POLL_INTERVAL });
});

// Same rule as the Folders page: no update tags unless update checks are on.
// `loaded` stays false when the settings fetch fails, so a failed fetch shows
// no update tags rather than tags based on the default setting.
function loadUpdates() {
  if (settingsStore.loaded && prefs.value.showTags && settingsStore.enableUpdateChecks) void updatesStore.fetchCachedUpdates();
}
watch(
  () => prefs.value.showTags,
  (on) => {
    if (!on) return;
    void scheduleStore.fetchSchedules();
    loadUpdates();
  },
);

onUnmounted(() => {
  window.removeEventListener('message', onParentMessage);
  syncRegistered([]);
});
</script>
