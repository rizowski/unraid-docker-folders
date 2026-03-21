<template>
  <div
    class="relative flex justify-between items-center px-3 py-3 sm:px-6 sm:py-4 bg-bg rounded-sm mb-4 cursor-pointer select-none border-l-4 hover:bg-bg-card transition"
    :class="{ 'z-50': menuOpen }"
    :style="{ borderLeftColor: folder.color || '#ff8c2f' }"
    @click="$emit('toggle-collapse')"
  >
    <div class="flex items-center gap-2 flex-1 min-w-0">
      <DragHandle v-if="!dragLocked" handle-class="folder-drag-handle shrink-0 text-text-secondary cursor-grab active:cursor-grabbing" />
      <ChevronIcon :expanded="!folder.collapsed" />
      <div
        v-if="containerIcons.length > 0"
        class="hidden sm:grid shrink-0 gap-0.5 mr-2"
        :class="containerIcons.length > 1 ? 'grid-cols-2 w-9 h-9' : 'grid-cols-1 w-9 h-9'"
      >
        <img v-for="(icon, i) in containerIcons" :key="i" :src="icon" class="w-full h-full object-contain rounded-sm" />
      </div>
      <h2 class="text-sm font-semibold text-text mr-1 truncate min-w-0">{{ folder.name }}</h2>
      <span
        v-if="folder.compose_project"
        class="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 bg-blue-500/15 text-blue-400 rounded text-[11px] font-medium tracking-wide uppercase mr-1"
        :title="`Auto-grouped from compose project: ${folder.compose_project}`"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>
        Compose
      </span>
      <ComposeControls
        v-if="folder.compose_project"
        :project-name="folder.compose_project"
        class="hidden sm:flex"
        @edit-compose="(p) => emit('edit-compose', p)"
        @view-logs="(p) => emit('view-logs', p)"
      />
      <span class="shrink-0 inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full text-xs font-semibold ml-1" :class="runningCount > 0 ? 'bg-primary text-primary-text' : 'bg-border text-text-secondary'" :title="`${runningCount} running / ${existingContainerCount} total`">
        {{ runningCount }}/{{ existingContainerCount }}
      </span>
      <span v-if="folderUpdateCount > 0" class="shrink-0 inline-flex items-center justify-center min-w-6 h-6 px-2 rounded-full text-xs font-semibold ml-1 bg-warning/20 text-warning" :title="`${folderUpdateCount} update(s) available`">
        <span class="hidden sm:inline">{{ folderUpdateCount }} update{{ folderUpdateCount > 1 ? 's' : '' }}</span>
        <span class="sm:hidden">{{ folderUpdateCount }}</span>
      </span>
      <span v-if="folder.collapsed && collapsedPorts" class="hidden sm:inline text-[11px] text-text font-mono ml-2 truncate">Ports: {{ collapsedPorts }}</span>
      <!-- Folder average stats loading -->
      <div v-if="folder.collapsed && settingsStore.showStats && !folderStats && runningCount > 0" class="hidden md:flex items-center gap-3 ml-auto mr-4 shrink-0">
        <StatsBar label="CPU" :percent="null" size="inline" />
        <StatsBar label="MEM" :percent="null" size="inline" />
      </div>
      <!-- Folder average stats -->
      <div v-if="folder.collapsed && settingsStore.showStats && folderStats" class="hidden md:flex items-center gap-3 ml-auto mr-4 shrink-0" @click.stop>
        <StatsBar label="CPU" :percent="folderStats.cpuPercent" size="inline" />
        <StatsBar label="MEM" :percent="folderStats.memPercent" size="inline" />
      </div>
    </div>
    <div class="flex items-center gap-2 sm:gap-3 shrink-0" @click.stop>
      <button
        class="p-1.5 rounded cursor-pointer transition relative"
        :class="hideStopped ? 'text-text' : 'text-text-secondary hover:text-text'"
        :title="hideStopped ? 'Show stopped containers' : 'Hide stopped containers'"
        @click="$emit('toggle-hide-stopped')"
      >
        <svg v-if="hideStopped" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span v-if="hideStopped && hiddenCount > 0" class="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 bg-text-secondary text-white rounded-full text-[10px] font-bold">{{ hiddenCount }}</span>
      </button>
      <span class="p-1.5 rounded" :class="allAutostart ? 'text-success' : 'text-text-secondary opacity-30'" :title="allAutostart ? 'All containers set to autostart' : 'Not all containers set to autostart'"><IconAutostart :size="16" /></span>
    <KebabMenu
      ref="kebabMenu"
      :items="folderMenuItems"
      button-title="Folder actions"
      button-class="p-2 border-none rounded cursor-pointer transition text-text-secondary hover:text-text"
      @select="handleMenuSelect"
    />
    </div>
  </div>
  <InputModal
    :is-open="showDelayModal"
    title="Folder Autostart Delay"
    :description="`Set delay before all containers in &quot;${folder.name}&quot; start automatically (in seconds).`"
    :initial-value="String(folderAutostartDelay)"
    placeholder="0"
    suffix="Seconds to wait before starting containers on boot. Applied to all containers in this folder."
    input-type="number"
    confirm-label="Save"
    @confirm="handleFolderDelayConfirm"
    @cancel="showDelayModal = false"
  />
</template>

<script setup lang="ts">
import { computed, inject, ref, type Ref } from 'vue';
import { useDockerStore } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { useStatsStore } from '@/stores/stats';
import { useUpdatesStore } from '@/stores/updates';
import { useComposeStore } from '@/stores/compose';
import KebabMenu from '@/components/KebabMenu.vue';
import type { KebabMenuItem } from '@/components/KebabMenu.vue';
import ComposeControls from '@/components/compose/ComposeControls.vue';
import StatsBar from '@/components/common/StatsBar.vue';
import DragHandle from '@/components/common/DragHandle.vue';
import ChevronIcon from '@/components/common/ChevronIcon.vue';
import IconAutostart from '@/components/icons/IconAutostart.vue';
import InputModal from '@/components/InputModal.vue';
import type { Folder } from '@/types/folder';

const dragLocked = inject<Ref<boolean>>('dragLocked', ref(false));

const kebabMenu = ref<InstanceType<typeof KebabMenu> | null>(null);
const menuOpen = computed(() => kebabMenu.value?.menuOpen ?? false);

interface Props {
  folder: Folder;
  hideStopped?: boolean;
  hiddenCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  hideStopped: false,
  hiddenCount: 0,
});

const emit = defineEmits<{
  'toggle-collapse': [];
  'toggle-hide-stopped': [];
  edit: [];
  delete: [];
  'update-folder': [];
  'edit-compose': [project: string];
  'view-logs': [project: string];
}>();

const updatesStore = useUpdatesStore();
const composeStore = useComposeStore();

const folderUpdateCount = computed(() => {
  if (!settingsStore.enableUpdateChecks) return 0;
  let count = 0;
  for (const assoc of props.folder.containers) {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    if (container && updatesStore.hasUpdate(container.image)) {
      count++;
    }
  }
  return count;
});

const composeStack = computed(() =>
  props.folder.compose_project ? composeStore.getStackByProject(props.folder.compose_project) : null
);

// Only count containers that still exist in Docker (filters out deleted/orphaned associations)
const existingContainers = computed(() =>
  props.folder.containers.filter((assoc) =>
    dockerStore.containers.some((c) => c.name === assoc.container_name)
  )
);
const existingContainerCount = computed(() => existingContainers.value.length);

const allAutostart = computed(() => {
  const containers = existingContainers.value;
  if (containers.length === 0) return false;
  return containers.every((assoc) => {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    return container?.autostart === true;
  });
});

const folderAutostartDelay = computed(() => {
  const delays = props.folder.containers
    .map((assoc) => dockerStore.containers.find((c) => c.name === assoc.container_name))
    .filter((c) => c?.managed === 'dockerman')
    .map((c) => c!.autostartDelay);
  if (delays.length === 0) return 0;
  // Show common delay if all the same, otherwise 0
  return delays.every((d) => d === delays[0]) ? delays[0] : 0;
});

const folderMenuItems = computed<KebabMenuItem[]>(() => {
  const items: KebabMenuItem[] = [
    { label: `Update (${folderUpdateCount.value})`, icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3', action: 'update-folder', class: 'text-warning hover:text-warning', show: folderUpdateCount.value > 0 },
  ];

  // Compose-specific menu items (shown on small screens where inline controls are hidden)
  if (props.folder.compose_project && composeStore.composeAvailable) {
    items.push(
      { label: 'Stack Up', icon: 'M5 3l14 9-14 9V3z', action: 'compose-up', show: composeStore.managementEnabled },
      { label: 'Stack Down', icon: 'M6 4h4v16H6zM14 4h4v16h-4z', action: 'compose-down', show: composeStore.managementEnabled },
      { label: 'Edit Compose', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8', action: 'compose-edit' },
      { label: 'Stack Logs', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', action: 'compose-logs' },
      { label: composeStack.value?.autostart ? 'Disable Autostart' : 'Enable Autostart', icon: 'M23 4v6h-6|M1 20v-6h6|M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15', action: 'compose-toggle-autostart', show: composeStore.managementEnabled },
    );
  }

  // Autostart controls for non-compose folders with dockerman containers
  const hasDockermanContainers = props.folder.containers.some((assoc) => {
    const c = dockerStore.containers.find((c) => c.name === assoc.container_name);
    return c?.managed === 'dockerman';
  });
  if (hasDockermanContainers && !props.folder.compose_project) {
    items.push(
      { label: allAutostart.value ? 'Disable Autostart (all)' : 'Enable Autostart (all)', icon: 'M17.65 6.35A8 8 0 1 0 19.73 15|M21 7L17.65 6.35 17 10|M8.5 17h7L12 7z|M10 14h4', action: 'toggle-folder-autostart', class: allAutostart.value ? 'text-success' : '' },
      { label: `Autostart Delay: ${folderAutostartDelay.value}s`, icon: 'M12 2v10l4.5 4.5', action: 'set-folder-autostart-delay', show: allAutostart.value },
    );
  }

  items.push(
    { label: 'Edit', icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z', action: 'edit' },
    { label: 'Delete', icon: 'M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M10 11v6|M14 11v6', action: 'delete', class: 'hover:text-error' },
  );

  return items;
});

async function handleMenuSelect(action: string) {
  if (action === 'edit') emit('edit');
  else if (action === 'delete') emit('delete');
  else if (action === 'update-folder') emit('update-folder');
  else if (action === 'compose-up' && props.folder.compose_project) {
    await composeStore.stackUp(props.folder.compose_project);
  } else if (action === 'compose-down' && props.folder.compose_project) {
    await composeStore.stackDown(props.folder.compose_project);
  } else if (action === 'compose-edit' && props.folder.compose_project) {
    emit('edit-compose', props.folder.compose_project);
  } else if (action === 'compose-logs' && props.folder.compose_project) {
    emit('view-logs', props.folder.compose_project);
  } else if (action === 'compose-toggle-autostart' && props.folder.compose_project && composeStack.value) {
    await composeStore.setAutostart(props.folder.compose_project, !composeStack.value.autostart);
  } else if (action === 'toggle-folder-autostart') {
    const enable = !allAutostart.value;
    const names = props.folder.containers
      .map((a) => dockerStore.containers.find((c) => c.name === a.container_name))
      .filter((c) => c?.managed === 'dockerman')
      .map((c) => c!.name);
    await Promise.all(names.map((n) => dockerStore.toggleAutostart(n, enable)));
  } else if (action === 'set-folder-autostart-delay') {
    showDelayModal.value = true;
  }
}

const showDelayModal = ref(false);

async function handleFolderDelayConfirm(value: string) {
  const delay = Math.max(0, parseInt(value) || 0);
  const names = props.folder.containers
    .map((a) => dockerStore.containers.find((c) => c.name === a.container_name))
    .filter((c) => c?.managed === 'dockerman')
    .map((c) => c!.name);
  await Promise.all(names.map((n) => dockerStore.toggleAutostart(n, true, delay)));
  showDelayModal.value = false;
}

const dockerStore = useDockerStore();
const settingsStore = useSettingsStore();
const statsStore = useStatsStore();

const collapsedPorts = computed(() => {
  if (!settingsStore.showFolderPorts) return '';
  const ports: number[] = [];
  for (const assoc of props.folder.containers) {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    if (container?.state !== 'running' || !container.ports?.length) continue;
    for (const p of container.ports) {
      if (p.PublicPort && !ports.includes(p.PublicPort)) {
        ports.push(p.PublicPort);
      }
    }
  }
  if (!ports.length) return '';
  return ports.sort((a, b) => a - b).join(', ');
});

const runningCount = computed(() => {
  return props.folder.containers.filter((assoc) => {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    return container?.state === 'running';
  }).length;
});

const containerIcons = computed(() => {
  const icons: string[] = [];
  for (const assoc of props.folder.containers) {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    if (container?.icon) icons.push(container.icon);
    if (icons.length >= 4) break;
  }
  return icons;
});

const folderStats = computed(() => {
  let cpuTotal = 0;
  let memTotal = 0;
  let count = 0;
  for (const assoc of props.folder.containers) {
    const container = dockerStore.containers.find((c) => c.name === assoc.container_name);
    if (!container) continue;
    const s = statsStore.getStats(container.id);
    if (!s) continue;
    cpuTotal += s.cpuPercent;
    memTotal += s.memoryPercent;
    count++;
  }
  if (count === 0) return null;
  return { cpuPercent: cpuTotal / count, memPercent: memTotal / count };
});
</script>
