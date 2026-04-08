<template>
  <Teleport to="body">
    <div v-if="isOpen && !inIframe" class="modal-enter absolute inset-0 z-[1000]" :style="{ minHeight: totalHeight + 'px' }">
      <div class="absolute inset-0 bg-black/50" @click="handleClose"></div>
      <div class="absolute flex items-center justify-center p-4" :style="viewportStyle">
      <div class="relative bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-border">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-text truncate">Pull Image Update</h2>
            <p class="text-xs text-text-secondary font-mono truncate mt-0.5">{{ image }}</p>
          </div>
          <button
            v-if="isDone"
            @click="handleClose"
            class="p-1.5 border-none rounded cursor-pointer transition text-text-secondary hover:text-text shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <!-- Status message -->
          <div class="flex items-center gap-2 text-sm">
            <svg v-if="!isDone" class="animate-spin h-4 w-4 text-primary shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <svg v-else-if="isComplete" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-success shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-error shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span class="text-text">{{ statusMessage }}</span>
          </div>

          <!-- Layer progress -->
          <div v-if="Object.keys(layers).length > 0" class="space-y-1.5">
            <div v-for="(layer, id) in layers" :key="id" class="flex items-center gap-2 text-xs">
              <span class="text-text-secondary font-mono w-16 shrink-0 truncate">{{ id }}</span>
              <div class="flex-1 h-1.5 stats-bar-track rounded-full overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-300"
                  :class="layer.percent >= 100 ? 'bg-success' : 'bg-primary'"
                  :style="{ width: Math.min(layer.percent, 100) + '%' }"
                ></div>
              </div>
              <span class="text-text-secondary w-20 text-right shrink-0">{{ layer.status }}</span>
            </div>
          </div>

          <!-- Error message -->
          <div v-if="errorMessage" class="text-sm text-error bg-error/10 px-3 py-2 rounded">
            {{ errorMessage }}
          </div>

          <!-- Recreate progress -->
          <div v-if="recreateStatus" class="flex items-center gap-2 text-sm">
            <span class="text-text">{{ recreateMessage }}</span>
          </div>

          <!-- Apply update link for dockerMan containers -->
          <div v-if="isComplete && managed === 'dockerman' && postPullAction === 'pull_and_offer_restart'" class="pt-2 border-t border-border">
            <a
              :href="applyUpdateUrl"
              class="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-text rounded text-sm font-medium no-underline hover:brightness-110 transition"
            >Apply Update</a>
            <p class="text-xs text-text-secondary mt-1.5">Opens Unraid's container update page to apply the new image.</p>
          </div>
        </div>

        <!-- Footer -->
        <div v-if="isDone" class="px-6 py-3 border-t border-border flex justify-end">
          <button
            @click="handleClose"
            class="px-4 py-1.5 bg-bg border border-border rounded cursor-pointer text-sm text-text hover:brightness-110 transition"
          >
            Close
          </button>
        </div>
      </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { getCsrfToken } from '@/utils/csrf';
import { useSettingsStore } from '@/stores/settings';
import { useParentViewport } from '@/composables/useParentViewport';
import { useParentModal } from '@/composables/useParentModal';

interface Props {
  isOpen: boolean;
  image: string;
  containerName: string;
  managed: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  complete: [image: string];
}>();

interface LayerProgress {
  status: string;
  current: number;
  total: number;
  percent: number;
}

const settingsStore = useSettingsStore();
const postPullAction = computed(() => settingsStore.postPullAction);

const { visibleTop, visibleHeight } = useParentViewport();
const totalHeight = computed(() =>
  Math.max(document.documentElement.scrollHeight, visibleTop.value + visibleHeight.value),
);
const viewportStyle = computed(() => ({
  top: visibleTop.value + 'px',
  left: '0',
  width: '100%',
  height: visibleHeight.value + 'px',
}));

const layers = ref<Record<string, LayerProgress>>({});
const statusMessage = ref('Preparing...');
const errorMessage = ref('');
const isComplete = ref(false);
const isDone = ref(false);
const recreateStatus = ref<'recreating' | 'recreated' | 'recreate_error' | null>(null);
const recreateMessage = ref('');
let abortController: AbortController | null = null;

const applyUpdateUrl = computed(() => {
  return `/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${props.containerName}.xml`;
});

const parentModal = useParentModal({
  onAction({ actionId }) {
    if (actionId === 'close' || actionId === 'cancel') {
      if (isDone.value) emit('close');
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'pull-progress',
    title: `Pull Image — ${props.image}`,
    size: 'md',
    dismissable: false,
    fields: [
      { type: 'status', id: 'status', message: statusMessage.value, spinner: true },
      { type: 'progress-list', id: 'layers', items: [] },
    ],
    actions: [
      { id: 'close', label: 'Close', variant: 'default', hidden: true },
    ],
  });
}

function patchStatus() {
  if (!inIframe) return;
  parentModal.update({
    fields: [
      {
        id: 'status',
        message: statusMessage.value,
        spinner: !isDone.value,
        variant: !isDone.value ? 'info' : (isComplete.value ? 'success' : 'error'),
      },
    ],
  });
}

function patchLayer(layerId: string) {
  if (!inIframe) return;
  const layer = layers.value[layerId];
  if (!layer) return;
  parentModal.update({
    fields: [
      {
        id: 'layers',
        items: [
          {
            id: layerId,
            label: layerId,
            percent: layer.percent,
            status: layer.status,
            state: layer.percent >= 100 ? 'done' : 'running',
          },
        ],
      },
    ],
  });
}

function showCloseButton() {
  if (!inIframe) return;
  parentModal.update({
    dismissable: true,
    actions: [
      { id: 'close', label: 'Close', variant: 'default' },
    ],
  });
}

function handleClose() {
  if (!isDone.value) return;
  emit('close');
}

function reset() {
  layers.value = {};
  statusMessage.value = 'Preparing...';
  errorMessage.value = '';
  isComplete.value = false;
  isDone.value = false;
  recreateStatus.value = null;
  recreateMessage.value = '';
}

async function startPull() {
  reset();
  if (inIframe) openParent();

  abortController = new AbortController();

  const API_BASE = '/plugins/unraid-docker-folders-modern/api';
  const token = getCsrfToken();
  const body = new URLSearchParams();
  if (token) body.append('csrf_token', token);

  try {
    const response = await fetch(
      `${API_BASE}/pull.php?image=${encodeURIComponent(props.image)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: abortController.signal,
      },
    );

    if (!response.ok) {
      errorMessage.value = `HTTP ${response.status}`;
      statusMessage.value = 'Error';
      isDone.value = true;
      patchStatus();
      showCloseButton();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      errorMessage.value = 'No response stream';
      statusMessage.value = 'Error';
      isDone.value = true;
      patchStatus();
      showCloseButton();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

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
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            handleSSEEvent(currentEvent, data);
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      errorMessage.value = e.message || 'Pull failed';
      statusMessage.value = 'Error';
    }
  }

  isDone.value = true;
  patchStatus();
  showCloseButton();
}

function handleSSEEvent(event: string, data: any) {
  switch (event) {
    case 'status':
      statusMessage.value = data.message || 'Pulling...';
      patchStatus();
      break;
    case 'progress':
      if (data.id) {
        const existing = layers.value[data.id] || { status: '', current: 0, total: 0, percent: 0 };
        const current = data.current ?? existing.current;
        const total = data.total ?? existing.total;
        const percent = total > 0 ? Math.round((current / total) * 100) : (data.status === 'Pull complete' || data.status === 'Already exists' ? 100 : existing.percent);
        layers.value[data.id] = { status: data.status || existing.status, current, total, percent };
        layers.value = { ...layers.value };
        patchLayer(data.id);
      }
      break;
    case 'complete':
      statusMessage.value = data.message || 'Pull complete';
      isComplete.value = true;
      patchStatus();
      emit('complete', props.image);
      break;
    case 'recreating':
      recreateStatus.value = 'recreating';
      recreateMessage.value = data.message || `Recreating ${data.container}...`;
      statusMessage.value = recreateMessage.value;
      patchStatus();
      break;
    case 'recreated':
      recreateStatus.value = 'recreated';
      recreateMessage.value = data.message || `${data.container} updated`;
      statusMessage.value = recreateMessage.value;
      patchStatus();
      break;
    case 'recreate_error':
      recreateStatus.value = 'recreate_error';
      recreateMessage.value = data.message || `Failed to recreate ${data.container}`;
      statusMessage.value = recreateMessage.value;
      patchStatus();
      break;
    case 'error':
      errorMessage.value = data.message || 'Pull failed';
      statusMessage.value = 'Error';
      patchStatus();
      break;
    case 'done':
      isDone.value = true;
      patchStatus();
      showCloseButton();
      break;
  }
}

watch(() => props.isOpen, (open) => {
  if (open) {
    startPull();
  } else {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (inIframe) parentModal.close();
  }
});
</script>
