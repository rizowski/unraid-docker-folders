<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="512px" @close="handleClose">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-border">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-text truncate">
              {{ modalTitle() }}
            </h2>
          </div>
          <button
            v-if="allDone"
            @click="handleClose"
            class="p-1.5 border-none rounded cursor-pointer transition text-text-secondary hover:text-text shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-6 py-4 space-y-2">
          <div
            v-for="(unit, idx) in units"
            :key="unit.id"
            class="flex items-start gap-2 py-2"
            :class="idx < units.length - 1 ? 'border-b border-border/30' : ''"
          >
            <div class="flex-1 min-w-0">
              <p class="text-sm text-text font-mono truncate">{{ unitLabel(unit) }}</p>
              <p class="text-xs text-text-secondary truncate">{{ unitStatusText(unit.id) }}</p>
              <p v-if="unitErrors[unit.id]" class="text-xs text-error mt-1">{{ unitErrors[unit.id] }}</p>
            </div>
            <span class="shrink-0 text-xs font-medium" :class="statusLabelClass(unit.id)">
              {{ statusLabel(unit.id) }}
            </span>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-6 py-3 border-t border-border flex justify-end">
          <div class="flex gap-2">
            <button
              v-if="!allDone"
              @click="cancelBatch"
              class="px-4 py-1.5 bg-bg border border-border rounded cursor-pointer text-sm text-text hover:brightness-110 transition"
            >
              Cancel
            </button>
            <button
              v-if="allDone"
              @click="handleClose"
              class="px-4 py-1.5 bg-bg border border-border rounded cursor-pointer text-sm text-text hover:brightness-110 transition"
            >
              Close
            </button>
          </div>
        </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { getCsrfToken } from '@/utils/csrf';
import { useParentModal } from '@/composables/useParentModal';
import { useSettingsStore } from '@/stores/settings';
import BaseModal from '@/components/BaseModal.vue';
import { unitLabel, type UpdateUnit } from '@/utils/updateUnits';

interface Props {
  isOpen: boolean;
  units: UpdateUnit[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  complete: [];
}>();

interface LayerProgress {
  status: string;
  current: number;
  total: number;
  percent: number;
}

type UnitResult = 'success' | 'error' | 'cancelled';

const settingsStore = useSettingsStore();

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

// All per-unit state is keyed by unit id — several units run at once, so
// nothing here can be a single in-flight value.
const unitRunning = ref<Record<string, boolean>>({});
const unitStatus = ref<Record<string, string>>({});
const unitLayers = ref<Record<string, Record<string, LayerProgress>>>({});
const unitResults = ref<Record<string, UnitResult>>({});
const unitErrors = ref<Record<string, string>>({});
const unitRecreate = ref<Record<string, string>>({});
const allDone = ref(false);

let cancelled = false;
/** One controller per in-flight unit; cancelling aborts every one of them. */
let controllers = new Set<AbortController>();
/** Guards against a pool settling after the modal has already closed. */
let runToken = 0;

const completedCount = computed(() => Object.keys(unitResults.value).length);

function statusLabel(id: string): string {
  const result = unitResults.value[id];
  if (result === 'success') return 'Done';
  if (result === 'error') return 'Error';
  if (result === 'cancelled') return 'Skipped';
  if (unitRunning.value[id]) return 'Updating';
  return 'Pending';
}

function statusLabelClass(id: string): string {
  const result = unitResults.value[id];
  if (result === 'success') return 'text-success';
  if (result === 'error') return 'text-error';
  if (result === 'cancelled') return 'text-text-secondary';
  if (unitRunning.value[id]) return 'text-primary';
  return 'text-text-secondary';
}

function unitState(id: string): 'pending' | 'running' | 'done' | 'error' | 'cancelled' {
  const result = unitResults.value[id];
  if (result === 'success') return 'done';
  if (result === 'error') return 'error';
  if (result === 'cancelled') return 'cancelled';
  if (unitRunning.value[id]) return 'running';
  return 'pending';
}

function unitPercent(id: string): number {
  if (unitResults.value[id]) return 100;
  if (!unitRunning.value[id]) return 0;
  const layers = Object.values(unitLayers.value[id] || {});
  if (layers.length === 0) return 5;
  const avg = layers.reduce((acc, l) => acc + l.percent, 0) / layers.length;
  return Math.max(5, avg);
}

function unitStatusText(id: string): string {
  const result = unitResults.value[id];
  if (result === 'success') return 'Done';
  if (result === 'error') return unitErrors.value[id] || 'Error';
  if (result === 'cancelled') return 'Skipped';
  if (unitRunning.value[id]) return unitStatus.value[id] || 'Updating...';
  return 'Pending';
}

function buildProgressItems() {
  return props.units.map((unit) => ({
    id: unit.id,
    label: unitLabel(unit),
    percent: unitPercent(unit.id),
    status: unitStatusText(unit.id),
    state: unitState(unit.id),
    sublabel: unitRecreate.value[unit.id] || '',
  }));
}

const parentModal = useParentModal({
  onAction({ actionId }) {
    if (actionId === 'cancel') {
      cancelBatch();
    } else if (actionId === 'close') {
      if (allDone.value) emit('close');
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'batch-pull-progress',
    title: `Updating Containers (0/${props.units.length})`,
    size: 'md',
    dismissable: false,
    fields: [
      { type: 'progress-list', id: 'units', items: buildProgressItems() },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'default' },
    ],
  });
}

function modalTitle(): string {
  return allDone.value
    ? 'Update Complete'
    : `Updating Containers (${completedCount.value}/${props.units.length})`;
}

function patchAll() {
  if (!inIframe) return;
  parentModal.update({
    title: modalTitle(),
    fields: [{ id: 'units', items: buildProgressItems() }],
  });
}

function patchUnit(unit: UpdateUnit) {
  if (!inIframe) return;
  parentModal.update({
    title: modalTitle(),
    fields: [
      {
        id: 'units',
        items: [
          {
            id: unit.id,
            label: unitLabel(unit),
            percent: unitPercent(unit.id),
            status: unitStatusText(unit.id),
            state: unitState(unit.id),
            sublabel: unitRecreate.value[unit.id] || '',
          },
        ],
      },
    ],
  });
}

function showCloseAction() {
  if (!inIframe) return;
  parentModal.update({
    dismissable: true,
    actions: [
      { id: 'close', label: 'Close', variant: 'default' },
    ],
  });
}

function handleClose() {
  if (!allDone.value) return;
  emit('close');
}

function cancelBatch() {
  cancelled = true;
  for (const controller of controllers) {
    controller.abort();
  }
  controllers = new Set();
}

function reset() {
  unitRunning.value = {};
  unitStatus.value = {};
  unitLayers.value = {};
  unitResults.value = {};
  unitErrors.value = {};
  unitRecreate.value = {};
  allDone.value = false;
  cancelled = false;
  controllers = new Set();
}

function setStatus(id: string, text: string) {
  unitStatus.value = { ...unitStatus.value, [id]: text };
}

/** The endpoint + body for a unit, keyed off its kind. */
function requestFor(unit: UpdateUnit): { url: string; body: URLSearchParams } {
  const body = new URLSearchParams();
  const token = getCsrfToken();
  if (token) body.append('csrf_token', token);

  if (unit.kind === 'compose') {
    // `up` pulls and then recreates changed services; `pull` downloads only.
    // Honour the same post-pull setting standalone containers use.
    const action = settingsStore.postPullAction === 'pull_and_auto_recreate' ? 'up' : 'pull';
    return {
      url: `${API_BASE}/compose-stream.php?action=${action}&project=${encodeURIComponent(unit.project)}`,
      body,
    };
  }

  // Send the exact container set the confirm dialog listed, so the backend
  // recreates those and nothing else.
  body.append('containers', unit.containers.map((c) => c.id).join(','));
  return {
    url: `${API_BASE}/pull.php?image=${encodeURIComponent(unit.image)}`,
    body,
  };
}

/**
 * Apply one SSE event to a unit's state. Returns 'success'/'error' on a
 * terminal event, otherwise null. `pull.php` and `compose-stream.php` share
 * the terminal vocabulary (complete/error/done) and differ only in how they
 * report progress, so one handler covers both.
 */
function applyEvent(
  unit: UpdateUnit,
  event: string,
  data: Record<string, any>,
): UnitResult | null {
  const id = unit.id;

  switch (event) {
    case 'status':
      setStatus(id, data.message || 'Updating...');
      break;

    // pull.php: per-layer download progress.
    case 'progress': {
      if (!data.id) break;
      const layers = { ...(unitLayers.value[id] || {}) };
      const existing = layers[data.id] || { status: '', current: 0, total: 0, percent: 0 };
      const current = data.current ?? existing.current;
      const total = data.total ?? existing.total;
      const percent = total > 0
        ? Math.round((current / total) * 100)
        : (data.status === 'Pull complete' || data.status === 'Already exists' ? 100 : existing.percent);
      layers[data.id] = { status: data.status || existing.status, current, total, percent };
      unitLayers.value = { ...unitLayers.value, [id]: layers };
      break;
    }

    // compose-stream.php: coarse phase markers, no layer data.
    case 'phase': {
      const percent = data.phase === 'starting' ? 80 : 40;
      unitLayers.value = { ...unitLayers.value, [id]: { phase: { status: data.phase || '', current: 0, total: 0, percent } } };
      setStatus(id, data.message || data.phase || 'Updating...');
      break;
    }

    // compose-stream.php: raw CLI output; show the newest non-empty line.
    case 'log': {
      const line = typeof data.line === 'string' ? data.line.trim() : '';
      if (line) setStatus(id, line);
      break;
    }

    case 'recreating':
    case 'recreated':
      setStatus(id, data.message || '');
      unitRecreate.value = { ...unitRecreate.value, [id]: data.message || '' };
      break;

    case 'recreate_error':
      unitRecreate.value = { ...unitRecreate.value, [id]: data.message || '' };
      break;

    case 'complete':
      return 'success';

    case 'error':
      unitErrors.value = { ...unitErrors.value, [id]: data.message || 'Update failed' };
      return 'error';
  }

  return null;
}

async function runUnit(unit: UpdateUnit): Promise<UnitResult> {
  unitRunning.value = { ...unitRunning.value, [unit.id]: true };
  setStatus(unit.id, 'Preparing...');
  patchUnit(unit);

  const controller = new AbortController();
  controllers.add(controller);

  const { url, body } = requestFor(unit);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) return 'error';

    const reader = response.body?.getReader();
    if (!reader) return 'error';

    const decoder = new TextDecoder();
    let buffer = '';
    let result: UnitResult = 'error';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7);
        } else if (line.startsWith('data: ')) {
          try {
            const terminal = applyEvent(unit, currentEvent, JSON.parse(line.slice(6)));
            if (terminal) result = terminal;
            patchUnit(unit);
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    return result;
  } catch (e: any) {
    if (e.name === 'AbortError') return 'error';
    unitErrors.value = { ...unitErrors.value, [unit.id]: e.message || 'Update failed' };
    return 'error';
  } finally {
    controllers.delete(controller);
    unitRunning.value = { ...unitRunning.value, [unit.id]: false };
  }
}

function finishUnit(unit: UpdateUnit, result: UnitResult) {
  unitResults.value = { ...unitResults.value, [unit.id]: result };
  patchUnit(unit);
}

async function startBatch() {
  reset();
  const token = ++runToken;
  if (inIframe) openParent();

  const units = [...props.units];
  const limit = Math.max(1, Math.min(settingsStore.updateConcurrency, units.length));

  // Worker pool: `limit` workers share one cursor, so a fast unit immediately
  // picks up the next instead of waiting on a slow sibling.
  let cursor = 0;
  const worker = async () => {
    while (cursor < units.length) {
      const unit = units[cursor++];
      if (cancelled) {
        finishUnit(unit, 'cancelled');
        continue;
      }
      const result = await runUnit(unit);
      finishUnit(unit, cancelled && result === 'error' ? 'cancelled' : result);
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));

  // The modal may have been closed (and a new batch started) while the pool
  // drained — don't resurrect a dead run.
  if (token !== runToken || !props.isOpen) return;

  allDone.value = true;
  patchAll();
  showCloseAction();
  emit('complete');
}

watch(() => props.isOpen, (open) => {
  if (open && props.units.length > 0) {
    startBatch();
  } else if (!open) {
    runToken++;
    cancelBatch();
    if (inIframe) parentModal.close();
  }
});
</script>
