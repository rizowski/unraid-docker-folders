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

    <p v-if="isLoading" class="text-xs text-text-secondary py-1">Loading...</p>
    <p v-else-if="error" class="text-xs text-error py-1">Error: {{ error }}</p>
    <p v-else-if="groups.length === 0" class="text-xs text-text-secondary py-1">
      {{ query ? 'No containers match.' : prefs.hideStopped ? 'No running containers.' : 'No containers.' }}
    </p>

    <div v-else class="flex flex-col">
      <section v-for="group in groups" :key="group.key" class="border-b border-border last:border-b-0">
        <div
          class="flex items-center gap-2 py-1.5 pr-2 cursor-pointer select-none hover:bg-bg-card"
          :style="{ borderLeft: `3px solid ${group.color}`, paddingLeft: '6px' }"
          role="button"
          :aria-expanded="isExpanded(group)"
          tabindex="0"
          @click="toggle(group.key)"
          @keydown.enter.prevent="toggle(group.key)"
          @keydown.space.prevent="toggle(group.key)"
        >
          <ChevronIcon :expanded="isExpanded(group)" :size="12" />
          <span class="flex-1 min-w-0 text-sm font-semibold truncate">{{ group.name }}</span>
          <span
            class="shrink-0 text-xs text-text-secondary"
            :title="`${group.running} running / ${group.total} total`"
          >{{ group.running }}/{{ group.total }}</span>
        </div>
        <div v-if="isExpanded(group)" class="pb-1">
          <WidgetContainerRow
            v-for="container in group.containers"
            :key="container.id"
            :container="container"
            :distinguish-healthy="settingsStore.distinguishHealthy"
            :show-icon="prefs.showIcons"
            :show-webui="prefs.showWebui"
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
import WidgetSettingsPanel from './WidgetSettings.vue';
import { loadWidgetSettings, saveWidgetSettings } from './widgetSettings';
import { useDockerStore, type Container } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import { useSettingsStore } from '@/stores/settings';
import { initWebSocket } from '@/composables/useWebSocket';
import { containerMatchesSearch } from '@/utils/search';
import { isAliveContainer } from '@/utils/containerDisplay';
import { effectiveSortMode, sortByMode } from '@/utils/sortMode';
import { reportHeightToParent } from '@/utils/iframeHost';
import { safeLocalStorageGetJson, safeLocalStorageSet } from '@/utils/safeStorage';

/** Slower than the Folders page: the dashboard is often left open for hours. */
const WIDGET_POLL_INTERVAL = 60000;
const COLLAPSE_KEY = 'docker-folders-widget-collapsed';
const OTHER_KEY = 'other';

interface Group {
  key: string;
  name: string;
  color: string;
  containers: Container[];
  running: number;
  total: number;
}

const dockerStore = useDockerStore();
const folderStore = useFolderStore();
const settingsStore = useSettingsStore();

const query = ref('');
const isSearching = computed(() => query.value.trim().length > 0);
const isLoading = computed(() => dockerStore.loading || folderStore.loading);
const error = computed(() => dockerStore.error || folderStore.error);

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
    result.push(makeGroup(`folder-${folder.id}`, folder.name, folder.color || 'var(--border-color)', members));
  }
  result.push(makeGroup(OTHER_KEY, 'Other', 'var(--border-color)', dockerStore.unfolderedContainers));
  return result;
});

function makeGroup(key: string, name: string, color: string, members: Container[]): Group {
  const running = members.filter((c) => c.state === 'running').length;
  return { key, name, color, containers: members, running, total: members.length };
}

const prefs = ref(loadWidgetSettings());
watch(prefs, saveWidgetSettings);
const settingsOpen = ref(false);
// Its own computed, so changing another setting does not rerun the group filter.
const hideStopped = computed(() => prefs.value.hideStopped);

// The cog in the tile header lives in the dashboard page, outside this frame,
// so it asks for the panel with a message.
function onParentMessage(e: MessageEvent) {
  if (e.source !== window.parent || e.origin !== window.location.origin) return;
  if (e.data?.type === 'docker-folders-widget-settings') settingsOpen.value = !settingsOpen.value;
}

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
  if (rootEl.value) resendHeight = reportHeightToParent(rootEl.value, () => menuBottom);
  await Promise.all([dockerStore.fetchContainers(), folderStore.fetchFolders(), settingsStore.fetchSettings()]);
  initWebSocket({ pollInterval: WIDGET_POLL_INTERVAL });
});

onUnmounted(() => window.removeEventListener('message', onParentMessage));
</script>
