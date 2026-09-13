<template>
  <!-- Grid (card) view -->
  <div v-if="view === 'grid'" class="container-card-enter flex flex-col border border-border/50 rounded-lg bg-bg-card hover:border-border hover:shadow-sm transition" :class="{ 'state-change-pulse': stateChangePulse, 'z-50': menuOpen, 'col-span-full': expanded }" :data-container-id="container.id">
    <!-- Everything above the action footer toggles the card. Only the footer
         (all buttons/links) and the expanded body are excluded. -->
    <div class="cursor-pointer select-none" @click="expanded = !expanded">
      <div class="flex items-center gap-2 px-4 sm:px-6 pt-4 sm:pt-6 pb-0">
        <DragHandle v-if="!dragLocked" handle-class="drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing" @click.stop />
        <ContainerIcon
          :src="container.icon || fallbackIcon"
          :alt="container.name"
          :halo-class="status.halo"
          :status-tooltip="status.tooltip"
          :href="iconWebui"
        />
        <h3 class="flex-1 text-sm font-semibold text-text truncate">{{ container.name }}</h3>
        <a
          v-if="hasUpdate && releaseNotesUrl"
          :href="releaseNotesUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning hover:bg-warning/30"
          title="View release notes"
          @click.stop
        >Update</a>
        <span
          v-else-if="hasUpdate"
          class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning"
        >Update</span>
        <span
          v-if="checkingUpdates"
          class="shrink-0 inline-flex items-center gap-1 text-[10px] text-text-secondary"
          title="Checking for image updates"
        >
          <svg class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          Checking
        </span>
        <span
          v-if="hasPortConflict"
          class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-error/15 text-error"
          :title="portConflictTitle"
        >Port Conflict</span>
      </div>
  
      <!-- Summary row — carries the chevron affordance -->
      <div class="flex items-center gap-2 px-4 sm:px-6 py-2">
        <p class="flex-1 text-[11px] text-text-secondary font-mono truncate min-w-0">
          <ImageLink :image="container.image" :href="imageLink" />
        </p>
        <span class="text-[11px] text-text shrink-0">{{ container.status }}</span>
        <ChevronIcon :expanded="expanded" />
      </div>
  
      <!-- Compact ports (collapsed) -->
      <div v-if="compactPorts && !expanded" class="px-4 sm:px-6 pb-0.5">
        <span class="text-[11px] text-text font-mono truncate block">Ports: {{ compactPorts }}</span>
      </div>
  
      <!-- Compact stats loading state -->
      <div v-if="isRunning && showStats && !containerStats && !expanded" class="px-4 sm:px-6 pb-1 space-y-1">
        <StatsBar label="CPU" :percent="null" />
        <StatsBar label="MEM" :percent="null" />
      </div>
  
      <!-- Compact stats bars (always visible for running containers) -->
      <div v-if="isRunning && containerStats && !expanded" class="px-4 sm:px-6 pb-1 space-y-1">
        <StatsBar label="CPU" :percent="containerStats.cpuPercent" />
        <StatsBar label="MEM" :percent="containerStats.memoryPercent" />
        <div v-if="containerStats.restartCount > 0" class="flex items-center gap-2 text-xs">
          <span class="inline-flex items-center gap-1.5 px-2 py-0.5 bg-error/15 text-error rounded text-[11px] font-mono font-medium">
            {{ containerStats.restartCount }} restart{{ containerStats.restartCount !== 1 ? 's' : '' }}
          </span>
        </div>
      </div>
    </div>

    <!-- Accordion details -->
    <Transition @enter="expandEnter" @after-enter="expandAfterEnter" @leave="expandLeave" @after-leave="expandAfterLeave">
      <div v-if="expanded" class="overflow-hidden">
        <ContainerDetails
          class="block px-4 sm:px-6 pb-2 pt-3 border-t border-border"
          v-bind="detailsProps"
          @refresh-logs="fetchLogs"
        />
      </div>
    </Transition>

    <div class="flex items-center gap-3 px-4 py-2 sm:px-6 sm:py-3 mt-auto border-t border-border/30">
      <template v-if="isActionInProgress">
        <div class="flex items-center gap-2 text-xs text-text-secondary">
          <svg class="animate-spin h-4 w-4 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <span>{{ actionStatusText }}</span>
        </div>
      </template>
      <template v-else>
      <button v-if="isPaused" @click="emit('resume', container.id)" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Resume"><IconPlay :size="20" /></button>
      <button v-else-if="isRunning" @click="confirmAction = 'stop'" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Stop"><IconStop :size="20" /></button>
      <button v-else @click="emit('start', container.id)" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Start"><IconPlay :size="20" /></button>
      <button v-if="isRunning" @click="confirmAction = 'restart'" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Restart"><IconRestart :size="20" /></button>
      <button v-if="isStopped" @click="confirmAction = 'remove'" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Remove"><IconTrash :size="20" /></button>
      <button v-if="hasUpdate" @click="emit('pull', pullPayload())" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-warning hover:bg-warning hover:text-white" title="Pull Update"><IconDownload :size="20" /></button>
      <!-- Adopt: only for a container Unraid does not manage yet -->
      <button v-if="canAdopt" @click.stop="openAdopt" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text" title="Adopt into Unraid — let Unraid manage this container"><IconAdopt :size="20" /></button>
      </template>
      <!-- Autostart toggle -->
      <button v-if="isManaged" @click.stop="handleToggleAutostart" class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed" :class="container.autostart ? 'text-success' : 'text-text-secondary hover:text-success'" :title="container.autostart ? 'Autostart: ON (click to disable)' : 'Autostart: OFF (click to enable)'"><IconAutostart :size="20" /></button>
      <span v-else class="flex items-center justify-center w-8 h-8 rounded text-text-secondary opacity-30" :title="`Autostart: ${manageHint}`"><IconAutostart :size="20" /></span>
      <!-- WebUI (always shown, disabled when no webui) -->
      <a v-if="resolvedWebui && isRunning" :href="resolvedWebui" target="_blank" rel="noopener" class="flex items-center justify-center w-8 h-8 ml-auto rounded text-text-secondary hover:text-primary transition" title="Open WebUI" @click.stop><IconGlobe :size="20" /></a>
      <span v-else class="flex items-center justify-center w-8 h-8 ml-auto rounded text-text-secondary opacity-30" title="No WebUI configured. Set the WebUI field in the container's Unraid template to enable this."><IconGlobe :size="20" /></span>
      <!-- Kebab menu -->
      <KebabMenu
        ref="kebabMenuRef"
        :items="menuItems"
        position="above"
        button-class="flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-text-secondary hover:text-text"
        :class="{ 'ml-auto': !resolvedWebui || !isRunning }"
        @select="handleMenuAction"
      />
    </div>
  </div>

  <!-- List view -->
  <div v-else class="container-card-enter container-row rounded transition border-b border-border/50" :class="{ 'state-change-pulse': stateChangePulse, 'z-50': menuOpen }" :data-container-id="container.id">
    <div class="flex items-center gap-2 sm:gap-4 px-2 sm:px-4 py-3 cursor-pointer select-none" @click="expanded = !expanded">
      <DragHandle v-if="!dragLocked" :size="14" handle-class="drag-handle shrink-0 text-muted cursor-grab active:cursor-grabbing -mr-2" @click.stop />
      <ChevronIcon :expanded="expanded" :size="12" />
      <ContainerIcon
        :src="container.icon || fallbackIcon"
        :alt="container.name"
        :halo-class="status.halo"
        :status-tooltip="status.tooltip"
        :href="iconWebui"
      />

      <div class="flex flex-col flex-1 min-w-0 gap-0.5">
        <div class="flex items-center gap-3 min-w-0">
          <span class="text-xs font-semibold text-text truncate">{{ container.name }}</span>
          <a
            v-if="hasUpdate && releaseNotesUrl"
            :href="releaseNotesUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning hover:bg-warning/30"
            title="View release notes"
            @click.stop
          >Update</a>
          <span
            v-else-if="hasUpdate"
            class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-warning/20 text-warning"
          >Update</span>
          <span
            v-if="checkingUpdates"
            class="shrink-0 inline-flex items-center gap-1 text-[10px] text-text-secondary"
            title="Checking for image updates"
          >
            <svg class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
            Checking
          </span>
          <span
            v-if="hasPortConflict"
            class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-error/15 text-error"
            :title="portConflictTitle"
          >Port Conflict</span>
          <span class="hidden sm:inline text-[11px] text-text-secondary truncate">{{ container.status }}</span>
        </div>
        <span class="text-[11px] text-text-secondary font-mono truncate">
          <ImageLink :image="container.image" :href="imageLink" />
        </span>
      </div>

      <!-- Compact ports (list collapsed) -->
      <span v-if="compactPorts && !expanded" class="hidden sm:inline shrink-0 text-[11px] text-text font-mono">{{ compactPorts }}</span>

      <!-- Inline compact stats loading (list view) -->
      <div v-if="isRunning && showStats && !containerStats && !expanded" class="hidden md:block shrink-0 w-[140px] space-y-0.5">
        <StatsBar label="CPU" :percent="null" size="inline" />
        <StatsBar label="MEM" :percent="null" size="inline" />
      </div>

      <!-- Inline compact stats (list view) -->
      <div v-if="isRunning && containerStats && !expanded" class="hidden md:flex shrink-0 items-center gap-3">
        <div class="w-[140px] space-y-0.5">
          <StatsBar label="CPU" :percent="containerStats.cpuPercent" size="inline" />
          <StatsBar label="MEM" :percent="containerStats.memoryPercent" size="inline" />
        </div>
        <span v-if="containerStats.restartCount > 0" class="inline-flex items-center px-1.5 py-0.5 bg-error/15 text-error rounded text-[11px] font-mono font-medium shrink-0" :title="`${containerStats.restartCount} restart(s)`">
          {{ containerStats.restartCount }} rst
        </span>
      </div>

      <div class="flex gap-1 ml-auto shrink-0 items-center" @click.stop>
        <template v-if="isActionInProgress">
          <div class="flex items-center gap-1.5 text-xs text-text-secondary mr-1">
            <svg class="animate-spin h-3.5 w-3.5 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span>{{ actionStatusText }}</span>
          </div>
        </template>
        <template v-else>
        <!-- WebUI (always shown, disabled when no webui) -->
        <a v-if="resolvedWebui && isRunning" :href="resolvedWebui" target="_blank" rel="noopener" class="hidden sm:flex items-center justify-center w-8 h-8 rounded text-text-secondary hover:text-primary transition" title="Open WebUI" @click.stop><IconGlobe :size="18" /></a>
        <span v-else class="hidden sm:flex items-center justify-center w-8 h-8 rounded text-text-secondary opacity-30" title="No WebUI configured. Set the WebUI field in the container's Unraid template to enable this."><IconGlobe :size="18" /></span>
        <button v-if="isPaused" @click="emit('resume', container.id)" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Resume"><IconPlay :size="18" /></button>
        <button v-else-if="isRunning" @click="confirmAction = 'stop'" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-error hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Stop"><IconStop :size="18" /></button>
        <button v-else @click="emit('start', container.id)" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-success hover:bg-success hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Start"><IconPlay :size="18" /></button>
        <button v-if="isRunning" @click="confirmAction = 'restart'" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Restart"><IconRestart :size="18" /></button>
        <button v-if="isStopped" @click="confirmAction = 'remove'" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-muted hover:bg-error hover:text-white disabled:opacity-50 disabled:cursor-not-allowed" :disabled="isActionInProgress" title="Remove"><IconTrash :size="18" /></button>
        <button v-if="hasUpdate" @click="emit('pull', pullPayload())" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-warning hover:bg-warning hover:text-white" title="Pull Update"><IconDownload :size="18" /></button>
        <!-- Adopt: only for a container Unraid does not manage yet -->
        <button v-if="canAdopt" @click.stop="openAdopt" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-primary hover:bg-primary hover:text-primary-text" title="Adopt into Unraid — let Unraid manage this container"><IconAdopt :size="18" /></button>
        <button v-if="isManaged" @click.stop="handleToggleAutostart" class="action-btn hidden sm:flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition disabled:opacity-50 disabled:cursor-not-allowed" :class="container.autostart ? 'text-success' : 'text-text-secondary hover:text-success'" :title="container.autostart ? 'Autostart: ON (click to disable)' : 'Autostart: OFF (click to enable)'"><IconAutostart :size="18" /></button>
        <span v-else class="action-btn hidden sm:flex items-center justify-center w-8 h-8 rounded text-text-secondary opacity-30" :title="`Autostart: ${manageHint}`"><IconAutostart :size="18" /></span>
        </template>
        <!-- Kebab menu -->
        <KebabMenu
          ref="kebabMenuRef"
          :items="menuItems"
          button-class="action-btn flex items-center justify-center w-8 h-8 border-none rounded cursor-pointer transition text-text-secondary hover:text-text"
          :icon-size="14"
          @select="handleMenuAction"
        />
      </div>
    </div>

    <!-- List accordion details -->
    <Transition @enter="expandEnter" @after-enter="expandAfterEnter" @leave="expandLeave" @after-leave="expandAfterLeave">
      <div v-if="expanded" class="overflow-hidden">
        <ContainerDetails
          class="block px-2 sm:px-4 pb-4 pt-2 border-t border-border"
          v-bind="detailsProps"
          @refresh-logs="fetchLogs"
        />
      </div>
    </Transition>
  </div>

  <Teleport to="body">
    <ConfirmModal
      :is-open="!!confirmAction"
      :title="confirmModalConfig.title"
      :message="confirmModalConfig.message"
      :confirm-label="confirmModalConfig.label"
      :variant="confirmModalConfig.variant"
      @confirm="handleConfirm"
      @cancel="confirmAction = null; removeImageToo = false"
    >
      <label v-if="confirmAction === 'remove'" class="flex items-center gap-2 mt-3 text-sm text-text-secondary cursor-pointer">
        <input type="checkbox" v-model="removeImageToo" class="cursor-pointer" />
        Also delete the image ({{ container.image }})
      </label>
    </ConfirmModal>
    <InputModal
      :is-open="showDelayModal"
      title="Autostart Delay"
      :description="`Set delay before ${container.name} starts automatically (in seconds).`"
      :initial-value="String(container.autostartDelay)"
      placeholder="0"
      suffix="Seconds to wait before starting this container on boot."
      input-type="number"
      confirm-label="Save"
      @confirm="handleDelayConfirm"
      @cancel="showDelayModal = false"
    />
    <SelectModal
      :is-open="showFolderPicker"
      :title="`${folderVerb} to Folder`"
      :description="`Choose a folder for ${container.name}.`"
      :options="folderTargets"
      :confirm-label="folderVerb"
      @confirm="handleFolderPicked"
      @cancel="showFolderPicker = false"
    />
    <AdoptModal
      :is-open="adoptOpen"
      :container-name="container.name"
      :data="adoptData"
      :error="adoptError"
      :is-running="isRunning"
      @adopt="runAdopt(false)"
      @dry-run="runAdopt(true)"
      @cancel="adoptOpen = false"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch, onUnmounted, type Ref } from 'vue';
import { useDockerStore, type Container, type PullRequest } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import { useUpdatesStore } from '@/stores/updates';
import { useFolderStore } from '@/stores/folders';
import { useContainerStats } from '@/composables/useContainerStats';
import { useIsMobile } from '@/composables/useIsMobile';
import { apiFetch } from '@/utils/csrf';
import { releaseIndexUrl } from '@/utils/updateUnits';
import { submitAdopt, type AdoptFields } from '@/utils/unraidHandoff';
import ConfirmModal from '@/components/ConfirmModal.vue';
import InputModal from '@/components/InputModal.vue';
import SelectModal from '@/components/SelectModal.vue';
import AdoptModal from '@/components/docker/AdoptModal.vue';
import KebabMenu from '@/components/KebabMenu.vue';
import type { KebabMenuItem } from '@/components/KebabMenu.vue';
import StatsBar from '@/components/common/StatsBar.vue';
import DragHandle from '@/components/common/DragHandle.vue';
import ChevronIcon from '@/components/common/ChevronIcon.vue';
import ImageLink from '@/components/common/ImageLink.vue';
import ContainerDetails from '@/components/docker/ContainerDetails.vue';
import ContainerIcon from '@/components/docker/ContainerIcon.vue';
import { containerStatus, containerEditUrl, openContainerTerminal } from '@/utils/containerDisplay';
import IconPlay from '@/components/icons/IconPlay.vue';
import IconStop from '@/components/icons/IconStop.vue';
import IconRestart from '@/components/icons/IconRestart.vue';
import IconTrash from '@/components/icons/IconTrash.vue';
import IconDownload from '@/components/icons/IconDownload.vue';
import IconGlobe from '@/components/icons/IconGlobe.vue';
import IconAutostart from '@/components/icons/IconAutostart.vue';
import IconAdopt from '@/components/icons/IconAdopt.vue';
// Vite copies public/ files to outDir root; BASE_URL ensures correct path in dev + prod
const fallbackIcon = `${import.meta.env.BASE_URL}docker.svg`;

const isMobile = useIsMobile();
const dockerStore = useDockerStore();
const kebabMenuRef = ref<InstanceType<typeof KebabMenu> | null>(null);
const menuOpen = computed(() => kebabMenuRef.value?.menuOpen ?? false);

interface Props {
  container: Container;
  actionInProgress?: string | null;
  view?: 'grid' | 'list';
}

const props = withDefaults(defineProps<Props>(), {
  view: 'grid',
});

const emit = defineEmits<{
  start: [id: string];
  resume: [id: string];
  stop: [id: string];
  restart: [id: string];
  remove: [id: string, removeImage: boolean];
  pull: [data: PullRequest];
  schedules: [targetType: string, targetId: string];
}>();

const isActionInProgress = computed(() => !!props.actionInProgress);

const actionStatusText = computed(() => {
  switch (props.actionInProgress) {
    case 'start': return 'Starting...';
    case 'resume': return 'Resuming...';
    case 'stop': return 'Stopping...';
    case 'restart': return 'Restarting...';
    case 'remove': return 'Removing...';
    default: return '';
  }
});

// Autostart toggle
async function handleToggleAutostart() {
  await dockerStore.toggleAutostart(props.container.name, !props.container.autostart);
}

const confirmAction = ref<'stop' | 'restart' | 'remove' | 'force-update' | null>(null);
const removeImageToo = ref(false);
const showDelayModal = ref(false);

// Folder picker: the menu-driven twin of drag and drop, through the same store
// action. An empty value means "no folder".
const folderStore = useFolderStore();
const showFolderPicker = ref(false);
const currentFolder = computed(() => folderStore.getFolderForContainer(props.container.name));
const folderVerb = computed(() => (currentFolder.value ? 'Move' : 'Add'));
const folderTargets = computed(() => {
  const targets = folderStore.sortedFolders
    .filter((f) => f.id !== currentFolder.value?.id)
    .map((f) => ({ value: String(f.id), label: f.name }));
  if (currentFolder.value) {
    targets.push({ value: '', label: 'No folder' });
  }
  return targets;
});

async function handleFolderPicked(value: string) {
  showFolderPicker.value = false;
  await folderStore.moveContainerToFolder(value === '' ? null : Number(value), props.container.id, props.container.name);
}

// Handing a CLI-created container to Unraid's container manager. The modal opens
// straight away and fills in when the field set lands, so the click has a
// visible result even on a slow inspect.
const adoptOpen = ref(false);
const adoptData = ref<AdoptFields | null>(null);
const adoptError = ref<string | null>(null);

async function openAdopt() {
  adoptData.value = null;
  adoptError.value = null;
  adoptOpen.value = true;
  try {
    const res = await apiFetch(
      `${API_BASE}/containers.php?action=adopt-fields&id=${encodeURIComponent(props.container.name)}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.message || 'Failed to read the container');
    adoptData.value = data as AdoptFields;
  } catch (e) {
    adoptError.value = e instanceof Error ? e.message : 'Failed to read the container';
  }
}

/**
 * Hand off to Unraid. This navigates the whole Unraid page, so the modal is
 * closed first — coming back to a stale open modal would be worse than losing it.
 */
function runAdopt(dryRun: boolean) {
  const data = adoptData.value;
  if (!data) return;
  adoptOpen.value = false;
  submitAdopt(data, dryRun);
}

async function handleDelayConfirm(value: string) {
  const delay = Math.max(0, parseInt(value) || 0);
  await dockerStore.toggleAutostart(props.container.name, true, delay);
  showDelayModal.value = false;
}

const confirmModalConfig = computed(() => {
  switch (confirmAction.value) {
    case 'stop':
      return { title: 'Stop Container', message: `Stop "${props.container.name}"?`, label: 'Stop', variant: 'danger' as const };
    case 'restart':
      return { title: 'Restart Container', message: `Restart "${props.container.name}"?`, label: 'Restart', variant: 'default' as const };
    case 'remove':
      return { title: 'Remove Container', message: `Remove "${props.container.name}"? This cannot be undone.`, label: 'Remove', variant: 'danger' as const };
    case 'force-update':
      return { title: 'Force Update', message: `Pull "${props.container.image}" and recreate "${props.container.name}" even if no update is available?`, label: 'Force Update', variant: 'default' as const };
    default:
      return { title: '', message: '', label: '', variant: 'default' as const };
  }
});

function pullPayload(force = false): PullRequest {
  const { image, name, managed, id } = props.container;
  return force ? { image, name, managed, id, force } : { image, name, managed, id };
}

function handleConfirm() {
  const action = confirmAction.value;
  confirmAction.value = null;
  if (action === 'stop') emit('stop', props.container.id);
  else if (action === 'restart') emit('restart', props.container.id);
  else if (action === 'remove') emit('remove', props.container.id, removeImageToo.value);
  else if (action === 'force-update') emit('pull', pullPayload(true));
  removeImageToo.value = false;
}

const expanded = ref(false);
const settingsStore = useSettingsStore();
const updatesStore = useUpdatesStore();

// Height transition on the accordion. The details are only mounted while open,
// so this rides Vue's enter/leave rather than a CSS class toggle — the element
// and its content appear and disappear together, with no half-rendered frame.
// After the enter settles the height is cleared back to auto, so content that
// grows later (streaming logs) is not pinned to a stale measurement.
const EXPAND_DURATION = 200;
function expandEnter(el: Element, done: () => void) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.height = '0';
  htmlEl.style.transition = `height ${EXPAND_DURATION}ms ease`;
  // Reading offsetHeight forces a synchronous reflow so the browser commits
  // the starting height before the transition target is set. Without it the
  // two writes coalesce and the animation never runs.
  // oxlint-disable-next-line no-unused-expressions
  htmlEl.offsetHeight;
  htmlEl.style.height = htmlEl.scrollHeight + 'px';
  setTimeout(done, EXPAND_DURATION);
}
function expandAfterEnter(el: Element) {
  (el as HTMLElement).style.height = '';
  (el as HTMLElement).style.transition = '';
}
function expandLeave(el: Element, done: () => void) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.height = htmlEl.scrollHeight + 'px';
  htmlEl.style.transition = `height ${EXPAND_DURATION}ms ease`;
  // Same forced reflow as expandEnter — commit the measured height before
  // collapsing to 0, or the element just snaps shut.
  // oxlint-disable-next-line no-unused-expressions
  htmlEl.offsetHeight;
  htmlEl.style.height = '0';
  setTimeout(done, EXPAND_DURATION);
}
function expandAfterLeave(el: Element) {
  (el as HTMLElement).style.height = '';
  (el as HTMLElement).style.transition = '';
}

const isRunning = computed(() => props.container.state === 'running');
const isPaused = computed(() => props.container.state === 'paused');
const isStopped = computed(() => !isRunning.value && !isPaused.value);

const { showStats, containerStats } = useContainerStats({
  containerId: () => props.container.id,
  isRunning,
  expanded,
});

const portConflict = computed(() => dockerStore.getPortConflict(props.container.id));
const hasPortConflict = computed(() => !!portConflict.value);
const portConflictTitle = computed(() =>
  portConflict.value
    ? portConflict.value.conflicts
        .map((d) => `Port ${d.hostPort}/${d.type} is in use by ${d.heldBy.join(', ')}`)
        .join('; ')
    : ''
);

const hasUpdate = computed(() => settingsStore.enableUpdateChecks && updatesStore.hasUpdate(props.container.image));
// The kebab item that starts the check closes with the menu, so the running
// state needs a home on the card itself.
const checkingUpdates = computed(
  () => settingsStore.enableUpdateChecks && updatesStore.isTargetedCheck(props.container.image),
);
const releaseNotesUrl = computed<string | null>(() =>
  releaseIndexUrl(updatesStore.updates[props.container.image]),
);

// Inline logs panel, shown in both grid and list view. Ownership stays here rather than in
// ContainerDetails: that child is mid-leave-transition during a collapse and
// stops receiving prop updates, so it cannot tell when to stop polling.
const API_BASE = '/plugins/unraid-docker-folders-modern/api';
const logLines = ref<string[]>([]);
const newLineCount = ref(0);
const logsLoading = ref(false);
// Why Docker wouldn't serve the logs, when it says so. Distinct from an empty
// logLines, which just means the container hasn't logged anything.
const logError = ref('');
const logRefreshTimer = ref<ReturnType<typeof setInterval> | null>(null);

const shouldShowInlineLogs = computed(
  () => settingsStore.showInlineLogs && expanded.value && isRunning.value,
);

// Both view branches render the same details; only the padding differs.
const detailsProps = computed(() => ({
  container: props.container,
  containerStats: containerStats.value,
  showStats: showStats.value,
  isRunning: isRunning.value,
  imageLink: imageLink.value,
  showLogs: shouldShowInlineLogs.value,
  logLines: logLines.value,
  logError: logError.value,
  logsLoading: logsLoading.value,
  newLineCount: newLineCount.value,
}));

async function fetchLogs() {
  logsLoading.value = true;
  try {
    const res = await apiFetch(`${API_BASE}/containers.php?action=logs&id=${encodeURIComponent(props.container.name)}&tail=50`);
    if (res.ok) {
      const data = await res.json();
      const raw = data.logs || '';
      const prevFirst = logLines.value[0] || '';
      const lines = raw ? raw.split('\n') : [];

      // Determine how many lines at the top are new (logs are newest-first)
      if (prevFirst && lines.length > 0) {
        const prevIdx = lines.indexOf(prevFirst);
        newLineCount.value = prevIdx > 0 ? prevIdx : 0;
      } else {
        newLineCount.value = 0;
      }

      logLines.value = lines;
      // Matches the API's error envelope: `error` is a boolean, the human text
      // is in `message`.
      logError.value = data.error ? data.message || 'Failed to load logs.' : '';
    }
  } catch (e) {
    console.error('Error fetching logs:', e);
    logLines.value = [];
    logError.value = 'Failed to load logs.';
    newLineCount.value = 0;
  } finally {
    logsLoading.value = false;
  }
}

function startLogPolling() {
  stopLogPolling();
  fetchLogs();
  const interval = settingsStore.logRefreshInterval;
  if (interval > 0) {
    logRefreshTimer.value = setInterval(fetchLogs, interval * 1000);
  }
}

function stopLogPolling() {
  if (logRefreshTimer.value !== null) {
    clearInterval(logRefreshTimer.value);
    logRefreshTimer.value = null;
  }
}

watch(shouldShowInlineLogs, (show) => {
  if (show) startLogPolling();
  else stopLogPolling();
});

watch(() => settingsStore.logRefreshInterval, () => {
  if (shouldShowInlineLogs.value) startLogPolling();
});

// State change pulse animation
const stateChangePulse = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.container.state, () => {
  stateChangePulse.value = true;
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => { stateChangePulse.value = false; }, 600);
});

onUnmounted(() => {
  clearTimeout(pulseTimer);
  stopLogPolling();
});

const distinguishHealthy = inject<Ref<boolean>>('distinguishHealthy', ref(true));
const dragLocked = inject<Ref<boolean>>('dragLocked', ref(false));

// Halo and tooltip resolve together in containerStatus; see utils/containerDisplay.ts.
const status = computed(() => containerStatus(props.container, distinguishHealthy.value));

const editUrl = computed(() => containerEditUrl(props.container));

const resolvedWebui = computed(() => {
  const tpl = props.container.webui;
  if (!tpl) return null;
  let url = tpl;
  // Replace [IP] with current hostname
  url = url.replace('[IP]', window.location.hostname);
  // Replace [PORT:xxxx] with the mapped public port
  url = url.replace(/\[PORT:(\d+)\]/g, (_match, privatePort) => {
    const pNum = parseInt(privatePort);
    const mapped = props.container.ports?.find((p) => p.PrivatePort === pNum);
    return mapped?.PublicPort ? String(mapped.PublicPort) : privatePort;
  });
  return url;
});

// Same gate as the footer WebUI link, so the two can never disagree about
// whether a container has a reachable web interface.
const iconWebui = computed(() => (isRunning.value ? resolvedWebui.value : null));

const isCompose = computed(() => !!props.container.labels?.['com.docker.compose.project']);

const isManaged = computed(() => props.container.managed === 'dockerman');

/**
 * Compose containers are excluded on purpose: adopting one detaches it from its
 * stack, and `docker compose up` would then fight Unraid over it.
 *
 * The setting defaults to on, so treat "not loaded yet" as on. Otherwise the
 * action row reflows a moment after the page settles.
 */
const canAdopt = computed(
  () => !isManaged.value && !isCompose.value && (!settingsStore.loaded || settingsStore.enableAdopt),
);

/** Why an Unraid-only action is inert. Three different reasons, three answers. */
const manageHint = computed(() => {
  if (isManaged.value) return undefined;
  if (isCompose.value) {
    return 'Unraid does not manage Compose containers. Edit the stack instead.';
  }
  if (!canAdopt.value) {
    return 'Only available for containers that Unraid manages. Turn on adoption in Settings > Docker Folders.';
  }
  return 'Only available for containers that Unraid manages. Use Adopt into Unraid first.';
});

const supportUrl = computed(() => {
  return props.container.labels?.['net.unraid.docker.support'] || null;
});

const projectUrl = computed(() => {
  return props.container.labels?.['net.unraid.docker.project'] || null;
});

const menuItems = computed<KebabMenuItem[]>(() => [
  { label: 'Start', icon: 'M6 4l14 8-14 8z', action: 'start', class: 'text-success', show: props.view === 'list' && isMobile.value && isStopped.value },
  { label: 'Resume', icon: 'M6 4l14 8-14 8z', action: 'resume', class: 'text-success', show: props.view === 'list' && isMobile.value && isPaused.value },
  { label: 'Restart', icon: 'M1 4v6h6|M3.51 15a9 9 0 1 0 2.13-9.36L1 10', action: 'restart', class: 'text-primary', show: props.view === 'list' && isMobile.value && isRunning.value },
  { label: 'Update', icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3', action: 'update', class: 'text-warning', show: hasUpdate.value },
  { label: 'Force Update', icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M7 10l5 5 5-5|M12 15V3', action: 'force-update', class: 'text-warning', show: !hasUpdate.value && !isCompose.value },
  // Shown before settings land so the menu doesn't grow an entry a moment
  // after it opens; disabled until we know update checks are actually on.
  { label: updatesStore.isCheckingImage(props.container.image) ? 'Checking for Updates…' : 'Check for Updates', icon: 'M23 4v6h-6|M1 20v-6h6|M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15', action: 'check-updates', show: !settingsStore.loaded || settingsStore.enableUpdateChecks, disabled: !settingsStore.loaded, title: settingsStore.loaded ? undefined : 'Loading settings…' },
  // `href` is empty for an unmanaged container, so KebabMenu falls through to
  // its button branch, which is the only one that honours disabled/title.
  { label: 'Edit', icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z', href: editUrl.value || '', disabled: !editUrl.value, title: manageHint.value },
  { label: 'WebUI', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z', href: resolvedWebui.value || '', target: '_blank', show: !!resolvedWebui.value && isRunning.value },
  { label: 'Console', icon: 'M4 17l6-5-6-5|M12 19h8', action: 'console', show: isRunning.value && !isCompose.value },
  { label: 'Logs', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8', action: 'logs', show: !isCompose.value },
  { label: 'Project', icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71|M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71', href: projectUrl.value || imageLink.value || '', target: '_blank', show: !!(projectUrl.value || imageLink.value) },
  { label: 'Support', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', href: supportUrl.value || '', target: '_blank', show: !!supportUrl.value },
  { label: 'Adopt into Unraid', icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M17 8l-5-5-5 5|M12 3v12', action: 'adopt', show: canAdopt.value },
  { label: props.container.autostart ? 'Disable Autostart' : 'Enable Autostart', icon: 'M17.65 6.35A8 8 0 1 0 19.73 15|M21 7L17.65 6.35 17 10|M8.5 17h7L12 7z|M10 14h4', action: 'toggle-autostart', class: props.container.autostart ? 'text-success' : '', disabled: !isManaged.value, title: manageHint.value },
  { label: `Autostart Delay: ${props.container.autostartDelay ?? 0}s`, icon: 'M12 2v10l4.5 4.5', action: 'set-autostart-delay', show: !isManaged.value || props.container.autostart, disabled: !isManaged.value, title: manageHint.value },
  { divider: true },
  { label: 'Schedules', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M12 6v6l4 2', action: 'schedules' },
  { label: `${folderVerb.value} to Folder…`, icon: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z|M12 11v6|M9 14h6', action: 'pick-folder', show: folderTargets.value.length > 0 },
  { divider: true },
  { label: 'Stop', icon: 'M6 6h12v12H6z', action: 'stop', class: 'text-error', show: props.view === 'list' && isMobile.value && isRunning.value },
  { label: 'Remove', icon: 'M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M10 11v6|M14 11v6', action: 'remove', class: 'text-error', show: props.view === 'list' && isMobile.value && isStopped.value },
]);

async function handleMenuAction(action: string) {
  if (action === 'stop') {
    confirmAction.value = 'stop';
  } else if (action === 'start') {
    emit('start', props.container.id);
  } else if (action === 'resume') {
    emit('resume', props.container.id);
  } else if (action === 'restart') {
    confirmAction.value = 'restart';
  } else if (action === 'remove') {
    confirmAction.value = 'remove';
  } else if (action === 'update') {
    emit('pull', pullPayload());
  } else if (action === 'force-update') {
    confirmAction.value = 'force-update';
  } else if (action === 'check-updates') {
    if (!updatesStore.isCheckingImage(props.container.image)) {
      await updatesStore.checkImagesForUpdates([props.container.image]);
    }
  } else if (action === 'toggle-autostart') {
    handleToggleAutostart();
  } else if (action === 'adopt') {
    void openAdopt();
  } else if (action === 'set-autostart-delay') {
    showDelayModal.value = true;
  } else if (action === 'schedules') {
    emit('schedules', 'container', props.container.name);
  } else if (action === 'pick-folder') {
    showFolderPicker.value = true;
  } else if (action === 'console') {
    openContainerTerminal(props.container.name, 'console');
  } else if (action === 'logs') {
    openContainerTerminal(props.container.name, 'logs');
  }
}

const imageLink = computed(() => {
  const image = props.container.image;
  if (!image) return null;
  const nameOnly = image.split(':')[0];
  if (nameOnly.includes('.')) {
    return `https://${nameOnly}`;
  }
  if (nameOnly.includes('/')) {
    return `https://hub.docker.com/r/${nameOnly}`;
  }
  return `https://hub.docker.com/_/${nameOnly}`;
});

const compactPorts = computed(() => {
  const ports = props.container.ports;
  if (!ports?.length) return '';
  return ports
    .filter((p) => p.PublicPort)
    .slice(0, 3)
    .map((p) => String(p.PublicPort))
    .join(', ');
});

</script>
