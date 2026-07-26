<template>
  <div class="space-y-3 text-xs">
    <!-- Row 1: resource usage, full width -->
    <div class="space-y-1.5 min-w-0">
      <p class="text-text-secondary text-xs">Resource Usage</p>
      <template v-if="isRunning && containerStats">
        <StatsBar label="CPU" :percent="containerStats.cpuPercent" size="wide" />
        <StatsBar label="Memory" :percent="containerStats.memoryPercent" size="wide" :formatted-value="`${formatBytes(containerStats.memoryUsage)} / ${formatBytes(containerStats.memoryLimit)} (${formatPercent(containerStats.memoryPercent)})`" />
      </template>
      <template v-else-if="isRunning && showStats">
        <StatsBar label="CPU" :percent="null" size="wide" />
        <StatsBar label="Memory" :percent="null" size="wide" />
      </template>
      <p v-else-if="isRunning" class="text-text-secondary italic">Stats disabled</p>
      <p v-else class="text-text-secondary italic">Container not running</p>
    </div>

    <!-- Row 2: what the container is (left) | how it's behaving (right) -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2 pt-2 border-t border-border">
      <!-- Left: image, network, ports, volumes, health, command, labels.
           Spans the full row when no stats column exists or is expected, so a
           stopped container doesn't sit in half a row beside a blank track. The
           predicate matches the right cell's so nothing shifts on first poll. -->
      <div
        class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 content-start min-w-0"
        :class="{ 'md:col-span-2': !(isRunning && showStats) }"
      >
        <template v-if="container.image">
          <span class="text-text-secondary shrink-0">Image</span>
          <span class="text-text font-mono truncate">
            <ImageLink :image="container.image" :href="imageLink" />
          </span>
        </template>
        <template v-if="networkInfo">
          <span class="text-text-secondary shrink-0">Network</span>
          <span class="text-text font-mono truncate">{{ networkInfo.name }} {{ networkInfo.ip }}</span>
        </template>
        <template v-if="displayPorts.length">
          <span class="text-text-secondary shrink-0">Ports</span>
          <div class="font-mono space-y-0.5 min-w-0">
            <p v-for="(port, i) in displayPorts" :key="i" class="truncate" :class="port.conflictWith ? 'text-error' : 'text-text'">
              {{ port.text }}<span v-if="port.conflictWith"> — conflicts with {{ port.conflictWith.join(', ') }}</span>
            </p>
          </div>
        </template>
        <template v-if="displayMounts.length">
          <span class="text-text-secondary shrink-0">Volumes</span>
          <div class="text-text font-mono space-y-0.5 min-w-0 overflow-x-auto">
            <p v-for="mount in displayMounts" :key="mount.destination" class="sm:whitespace-nowrap" :title="`${mount.source} -> ${mount.destination}`">
              <a :href="`/Shares/Browse?dir=${encodeURIComponent(mount.source)}`" class="inline-flex items-center gap-1 hover:underline" @click.stop><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 inline"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>{{ mount.sourceShort }}</a> -&gt; {{ mount.destination }}
            </p>
          </div>
        </template>
        <template v-if="healthStatus">
          <span class="text-text-secondary shrink-0">Health</span>
          <span class="font-mono" :class="healthClass">{{ healthStatus }}</span>
        </template>
        <template v-if="container.command">
          <span class="text-text-secondary shrink-0">Command</span>
          <span class="text-text font-mono truncate" :title="container.command">{{ container.command }}</span>
        </template>
        <template v-if="displayLabels.length">
          <span class="text-text-secondary shrink-0">Labels</span>
          <div class="text-text font-mono space-y-0.5 min-w-0 overflow-x-auto">
            <p v-for="label in displayLabels" :key="label.key" class="text-[11px] whitespace-nowrap" :title="`${label.key}=${label.value}`">
              <span class="text-text">{{ label.key }}</span>=<span class="text-text-secondary">{{ label.value }}</span>
            </p>
          </div>
        </template>
        <p v-if="!hasMetadata" class="col-span-2 text-text-secondary italic">No additional details available</p>
      </div>
      <!-- Right: I/O, PIDs, uptime, sizes -->
      <div v-if="containerStats" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 content-start min-w-0">
        <span class="text-text-secondary">Block I/O</span>
        <span class="text-text font-mono truncate">R: {{ formatBytes(containerStats.blockRead) }} / W: {{ formatBytes(containerStats.blockWrite) }}</span>
        <span class="text-text-secondary">Net I/O</span>
        <span class="text-text font-mono truncate">RX: {{ formatBytes(containerStats.netRx) }} / TX: {{ formatBytes(containerStats.netTx) }}</span>
        <span class="text-text-secondary">PIDs</span>
        <span class="text-text font-mono">{{ containerStats.pids }}</span>
        <span class="text-text-secondary">Restarts</span>
        <span class="font-mono" :class="restartClass">{{ containerStats.restartCount }}</span>
        <span class="text-text-secondary">Uptime</span>
        <span class="text-text font-mono">{{ formatUptime(containerStats.startedAt) }}</span>
        <span class="text-text-secondary">Image Size</span>
        <span class="text-text font-mono">{{ formatBytes(containerStats.imageSize) }}</span>
        <span class="text-text-secondary">Log Size</span>
        <span class="font-mono" :class="logSizeClass">{{ formatBytes(containerStats.logSize) }}</span>
      </div>
    </div>

    <!-- Row 3: schedules acting on this container. Hidden entirely when there
         are none — most containers have no schedule, so an empty-state line
         here would be noise on every card. Management (add/edit/delete/history)
         stays in the ScheduleList modal behind the kebab. -->
    <div v-if="containerSchedules.length" class="pt-2 border-t border-border">
      <div class="flex items-center justify-between gap-2 mb-1">
        <p class="text-text-secondary text-xs">Schedules</p>
        <!-- Manage gates every mutation behind an explicit mode, so a stray
             click on a card can never change what runs on a container. -->
        <div class="flex items-center gap-2 shrink-0">
          <template v-if="manageMode">
            <button class="nav-btn" :disabled="applying" :class="{ 'opacity-50 cursor-not-allowed': applying }" @click.stop="cancelManage">Cancel</button>
            <button class="nav-btn active" :disabled="applying" :class="{ 'opacity-50 cursor-not-allowed': applying }" @click.stop="onDone">
              {{ applying ? 'Saving' : 'Done' }}
            </button>
          </template>
          <button v-else class="nav-btn" @click.stop="startManage">Manage</button>
        </div>
      </div>

      <div class="space-y-0.5">
        <div
          v-for="schedule in containerSchedules"
          :key="schedule.id"
          class="flex items-center gap-2 min-w-0"
          :class="{ 'opacity-50 line-through': stagedDeletes.has(schedule.id) }"
        >
          <input
            type="checkbox"
            :checked="displayEnabled(schedule)"
            :disabled="!manageMode || stagedDeletes.has(schedule.id)"
            class="shrink-0"
            :class="manageMode && !stagedDeletes.has(schedule.id) ? 'cursor-pointer' : 'cursor-default'"
            :aria-label="displayEnabled(schedule) ? `Disable ${schedule.name}` : `Enable ${schedule.name}`"
            :title="manageMode ? (displayEnabled(schedule) ? 'Disable' : 'Enable') : 'Click Manage to change'"
            @click.stop
            @change="toggleStaged(schedule)"
          />
          <span class="text-xs px-1.5 py-0.5 rounded bg-bg text-text-secondary shrink-0">{{ schedule.action }}</span>
          <span class="truncate" :class="displayEnabled(schedule) ? 'text-text' : 'text-muted'">{{ schedule.name }}</span>
          <!-- next_run_at stays populated on a disabled schedule, so never show
               a next run for one — it would read as still-armed. -->
          <span v-if="!displayEnabled(schedule)" class="text-muted shrink-0">disabled</span>
          <span v-else-if="schedule.next_run_at" class="text-text-secondary shrink-0">{{ formatTimeUntil(schedule.next_run_at) }}</span>
          <span v-if="schedule.last_run_status" class="text-text-secondary shrink-0">
            last <span :class="scheduleStatusClass(schedule.last_run_status)">{{ schedule.last_run_status }}</span>
          </span>

          <div class="flex items-center gap-1 shrink-0 ml-auto">
            <button
              class="icon-btn text-text-secondary hover:text-text"
              :aria-label="`Run history for ${schedule.name}`"
              title="Run history"
              @click.stop="historyId = schedule.id"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>
            </button>
            <template v-if="manageMode">
              <button
                class="icon-btn text-text-secondary hover:text-text"
                :disabled="stagedDeletes.has(schedule.id)"
                :class="{ 'opacity-50 cursor-not-allowed': stagedDeletes.has(schedule.id) }"
                :aria-label="`Edit ${schedule.name}`"
                title="Edit"
                @click.stop="editingId = schedule.id"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
              </button>
              <!-- Deletion is staged, not immediate: it commits on Done, behind
                   one confirmation covering every row marked in this session. -->
              <button
                class="icon-btn"
                :class="stagedDeletes.has(schedule.id) ? 'text-error' : 'text-text-secondary hover:text-error'"
                :aria-label="stagedDeletes.has(schedule.id) ? `Keep ${schedule.name}` : `Delete ${schedule.name}`"
                :title="stagedDeletes.has(schedule.id) ? 'Undo delete' : 'Delete'"
                @click.stop="toggleStagedDelete(schedule.id)"
              >
                <IconTrash :size="16" />
              </button>
            </template>
          </div>
        </div>
      </div>

      <p v-if="manageError" class="text-error mt-1">{{ manageError }}</p>
    </div>

    <!-- Row 4: inline logs -->
    <div v-if="showLogs" class="pt-2 border-t border-border">
      <div class="flex items-center justify-between mb-1">
        <p class="text-text-secondary text-xs">Logs</p>
        <button
          class="icon-btn text-text-secondary hover:text-text"
          aria-label="Refresh logs"
          title="Refresh logs"
          :disabled="logsLoading"
          :class="{ 'opacity-50 cursor-not-allowed': logsLoading }"
          @click.stop="emit('refresh-logs')"
        >
          <IconRestart :size="16" :class="{ 'animate-spin': logsLoading }" />
        </button>
      </div>
      <div
        class="log-pane rounded border border-border/50 p-2 font-mono text-[11px] leading-relaxed text-text-secondary overflow-y-auto max-h-[300px] break-all"
      >
        <template v-if="logsLoading && logLines.length === 0">
          <span class="text-muted italic">Loading logs...</span>
        </template>
        <template v-else-if="logLines.length > 0">
          <div
            v-for="(line, idx) in logLines"
            :key="idx"
            class="whitespace-pre-wrap"
            :class="{ 'log-line-new': idx < newLineCount }"
          >{{ line }}</div>
        </template>
        <template v-else-if="logError">
          <span class="text-error italic">{{ logError }}</span>
        </template>
        <template v-else>
          <span class="text-muted italic">No logs available.</span>
        </template>
      </div>
    </div>

    <!-- These teleport their own overlay to the app root, so they render as
         siblings of the card rather than inside its clipped accordion body. -->
    <ScheduleModal
      v-if="editingId !== null"
      :is-open="editingId !== null"
      target-type="container"
      :target-id="container.name"
      :edit-id="editingId"
      @close="editingId = null"
      @saved="editingId = null"
    />

    <ScheduleHistoryModal
      v-if="historyId !== null"
      :is-open="historyId !== null"
      :schedule-id="historyId"
      @close="historyId = null"
    />

    <ConfirmModal
      :is-open="confirmingDelete"
      title="Delete Schedules"
      :message="deleteConfirmMessage"
      confirm-label="Delete"
      variant="danger"
      @confirm="applyManage"
      @cancel="confirmingDelete = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDockerStore, type Container, type HostPortBinding } from '@/stores/docker';
import type { ContainerStats } from '@/stores/stats';
import { useScheduleStore } from '@/stores/schedules';
import type { Schedule } from '@/types/schedule';
import { formatBytes, formatPercent, formatUptime, formatTimeUntil, scheduleStatusClass } from '@/utils/format';
import StatsBar from '@/components/common/StatsBar.vue';
import ImageLink from '@/components/common/ImageLink.vue';
import IconRestart from '@/components/icons/IconRestart.vue';
import IconTrash from '@/components/icons/IconTrash.vue';
import ConfirmModal from '@/components/ConfirmModal.vue';
import ScheduleModal from '@/components/schedules/ScheduleModal.vue';
import ScheduleHistoryModal from '@/components/schedules/ScheduleHistoryModal.vue';

const props = withDefaults(
  defineProps<{
    container: Container;
    containerStats: ContainerStats | null;
    showStats: boolean;
    isRunning: boolean;
    imageLink: string | null;
    /**
     * Inline logs. Fetching lives in the parent: during a collapse this
     * component is mid-leave-transition and stops receiving prop updates, so it
     * cannot be trusted to know when to stop polling.
     *
     * The four log props below are optional because grid view passes
     * `show-logs="false"` and never has log state to give.
     */
    showLogs: boolean;
    logLines?: string[];
    /** Why the logs couldn't be read, if Docker told us. Empty when fine. */
    logError?: string;
    logsLoading?: boolean;
    newLineCount?: number;
  }>(),
  {
    logLines: () => [],
    logError: '',
    logsLoading: false,
    newLineCount: 0,
  },
);

const emit = defineEmits<{ (e: 'refresh-logs'): void }>();

const dockerStore = useDockerStore();
const scheduleStore = useScheduleStore();

// Schedules target a container by NAME, not by docker id — see the emit at
// ContainerCard's kebab handler. App.vue fetches schedules on load and the
// websocket refetches them, so there is nothing to fetch here.
const containerSchedules = computed(() =>
  scheduleStore.schedulesForTarget('container', props.container.name),
);

// --- Manage mode -----------------------------------------------------------
// Enable/disable and delete are staged locally and committed together, so a
// session of edits costs one bulk request each instead of one per row.
const manageMode = ref(false);
const applying = ref(false);
const manageError = ref('');
const confirmingDelete = ref(false);
const editingId = ref<number | null>(null);
const historyId = ref<number | null>(null);

/** id → staged enabled value. Holds only rows that differ from the server. */
const stagedEnabled = ref(new Map<number, boolean>());
const stagedDeletes = ref(new Set<number>());

function displayEnabled(schedule: Schedule): boolean {
  const staged = stagedEnabled.value.get(schedule.id);
  return staged === undefined ? schedule.enabled : staged;
}

function toggleStaged(schedule: Schedule) {
  const next = !displayEnabled(schedule);
  // Staging a row back to its server value clears it, so "Done" with no net
  // change sends nothing.
  if (next === schedule.enabled) {
    stagedEnabled.value.delete(schedule.id);
  } else {
    stagedEnabled.value.set(schedule.id, next);
  }
}

function toggleStagedDelete(id: number) {
  if (stagedDeletes.value.has(id)) {
    stagedDeletes.value.delete(id);
  } else {
    stagedDeletes.value.add(id);
  }
}

function startManage() {
  manageError.value = '';
  manageMode.value = true;
}

function resetStaging() {
  stagedEnabled.value.clear();
  stagedDeletes.value.clear();
}

function cancelManage() {
  resetStaging();
  manageError.value = '';
  manageMode.value = false;
}

// A row staged for deletion is excluded from the enable update — there is no
// point toggling something in the same breath as removing it.
const pendingUpdates = computed(() =>
  [...stagedEnabled.value.entries()]
    .filter(([id]) => !stagedDeletes.value.has(id))
    .map(([id, enabled]) => ({ id, enabled })),
);

const deleteConfirmMessage = computed(() => {
  const count = stagedDeletes.value.size;
  if (count === 1) {
    const doomed = containerSchedules.value.find((s) => stagedDeletes.value.has(s.id));
    return `Delete "${doomed?.name ?? 'this schedule'}"? This cannot be undone.`;
  }
  return `Delete ${count} schedules? This cannot be undone.`;
});

function onDone() {
  manageError.value = '';
  // Deletions are the only irreversible part, so they are the only thing that
  // needs confirming; a pure enable/disable pass commits straight away.
  if (stagedDeletes.value.size > 0) {
    confirmingDelete.value = true;
    return;
  }
  applyManage();
}

async function applyManage() {
  confirmingDelete.value = false;
  applying.value = true;
  manageError.value = '';

  try {
    const updates = pendingUpdates.value;
    if (updates.length > 0) {
      const result = await scheduleStore.bulkSetEnabled(updates);
      if (!result.success) {
        manageError.value = result.error ?? 'Failed to update schedules';
        return;
      }
    }

    const ids = [...stagedDeletes.value];
    if (ids.length > 0) {
      const result = await scheduleStore.bulkDelete(ids);
      if (!result.success) {
        manageError.value = result.error ?? 'Failed to delete schedules';
        return;
      }
    }

    resetStaging();
    manageMode.value = false;
  } finally {
    applying.value = false;
  }
}

const networkInfo = computed(() => {
  const nets = props.container.networkSettings;
  if (!nets) return null;
  const entries = Object.entries(nets);
  if (entries.length === 0) return null;
  const [name, data] = entries[0];
  return { name, ip: data?.IPAddress || '' };
});

// Conflicting host ports for this container, keyed by `${hostPort}/${type}` →
// names of the running containers holding them.
const conflictByHostPort = computed(() => {
  const map = new Map<string, string[]>();
  const info = dockerStore.getPortConflict(props.container.id);
  if (info) {
    for (const d of info.conflicts) {
      map.set(`${d.hostPort}/${d.type}`, d.heldBy);
    }
  }
  return map;
});

interface PortRow {
  text: string;
  conflictWith: string[] | null;
}

const displayPorts = computed<PortRow[]>(() => {
  const ports = props.container.ports ?? [];
  const hostPorts = props.container.hostPorts ?? [];
  const conflicts = conflictByHostPort.value;

  // Index configured host bindings by container port + protocol so we can
  // attach a host binding (and its conflict state) to each exposed port —
  // stopped containers don't carry PublicPort in their runtime ports.
  const bindingsByContainerPort = new Map<string, HostPortBinding[]>();
  for (const b of hostPorts) {
    const key = `${b.containerPort}/${b.type}`;
    const list = bindingsByContainerPort.get(key);
    if (list) list.push(b);
    else bindingsByContainerPort.set(key, [b]);
  }

  const row = (text: string, hostPort: number, type: string): PortRow => ({
    text,
    conflictWith: conflicts.get(`${hostPort}/${type}`) ?? null,
  });

  const rows: PortRow[] = [];

  if (ports.length) {
    for (const p of ports) {
      const bindings = bindingsByContainerPort.get(`${p.PrivatePort}/${p.Type}`);
      if (bindings?.length) {
        for (const b of bindings) {
          rows.push(row(`${p.PrivatePort}/${p.Type} -> ${b.hostIp || '0.0.0.0'}:${b.hostPort}`, b.hostPort, b.type));
        }
      } else if (p.PublicPort) {
        rows.push(row(`${p.PrivatePort}/${p.Type} -> ${p.IP || '0.0.0.0'}:${p.PublicPort}`, p.PublicPort, p.Type));
      } else {
        rows.push({ text: `${p.PrivatePort}/${p.Type}`, conflictWith: null });
      }
    }
  } else {
    // No runtime ports (some stopped containers) — show configured bindings.
    for (const b of hostPorts) {
      rows.push(row(`${b.containerPort}/${b.type} -> ${b.hostIp || '0.0.0.0'}:${b.hostPort}`, b.hostPort, b.type));
    }
  }

  return rows.slice(0, 3);
});

const displayMounts = computed(() => {
  const mounts = props.container.mounts;
  if (!mounts?.length) return [];
  return mounts.slice(0, 2).map((m) => {
    // Show full path — strip /mnt/user/ prefix for brevity on Unraid shares
    let srcShort = m.Source;
    if (srcShort.startsWith('/mnt/user/')) {
      srcShort = srcShort.slice('/mnt/user/'.length);
    }
    return { destination: m.Destination, source: m.Source, sourceShort: srcShort };
  });
});

const healthStatus = computed(() => {
  const status = props.container.status?.toLowerCase() || '';
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('(health: starting)')) return 'starting';
  return null;
});

const healthClass = computed(() => {
  switch (healthStatus.value) {
    case 'healthy': return 'text-success';
    case 'unhealthy': return 'text-error';
    case 'starting': return 'text-warning';
    default: return 'text-text-secondary';
  }
});

const displayLabels = computed(() => {
  const labels = props.container.labels;
  if (!labels) return [];
  // Filter out internal/noisy labels
  const hidden = new Set([
    'maintainer',
    'org.opencontainers.image.created',
    'org.opencontainers.image.revision',
    'org.opencontainers.image.source',
    'org.opencontainers.image.version',
  ]);
  return Object.entries(labels)
    .filter(([key]) => !hidden.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 15)
    .map(([key, value]) => ({ key, value }));
});

const logSizeClass = computed(() => {
  const size = props.containerStats?.logSize ?? 0;
  if (size > 1_073_741_824) return 'text-error';
  if (size > 104_857_600) return 'text-warning';
  return 'text-text-secondary';
});

const restartClass = computed(() =>
  (props.containerStats?.restartCount ?? 0) > 0 ? 'text-error' : 'text-text-secondary',
);

// Whether the left cell has anything at all to show; drives the italic fallback.
const hasMetadata = computed(
  () =>
    !!props.container.image ||
    !!networkInfo.value ||
    displayPorts.value.length > 0 ||
    displayMounts.value.length > 0 ||
    !!healthStatus.value ||
    !!props.container.command ||
    displayLabels.value.length > 0,
);


</script>
