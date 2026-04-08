<template>
  <Teleport to="body">
    <div v-if="isOpen && !inIframe" class="modal-enter absolute inset-0 z-[1000]" :style="{ minHeight: totalHeight + 'px' }">
      <div class="absolute inset-0 bg-black/50" @click="handleClose"></div>
      <div class="absolute flex items-center justify-center p-4" :style="viewportStyle">
      <div class="relative bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-border">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-text truncate">
              {{ allDone ? 'Update Complete' : `Updating Containers (${completedCount}/${uniqueImages.length})` }}
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
            v-for="(img, idx) in uniqueImages"
            :key="img"
            class="flex items-start gap-2 py-2"
            :class="idx < uniqueImages.length - 1 ? 'border-b border-border/30' : ''"
          >
            <div class="flex-1 min-w-0">
              <p class="text-sm text-text font-mono truncate">{{ img }}</p>
              <p v-if="imageErrors[img]" class="text-xs text-error mt-1">{{ imageErrors[img] }}</p>
            </div>
            <span class="shrink-0 text-xs font-medium" :class="statusLabelClass(img)">
              {{ statusLabel(img) }}
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
      </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { getCsrfToken } from '@/utils/csrf';
import { useParentViewport } from '@/composables/useParentViewport';
import { useParentModal } from '@/composables/useParentModal';

interface PullContainer {
  image: string;
  name: string;
  managed: string | null;
}

interface Props {
  isOpen: boolean;
  containers: PullContainer[];
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

const uniqueImages = computed(() => [...new Set(props.containers.map((c) => c.image))]);

const currentImage = ref<string | null>(null);
const currentStatus = ref('');
const currentLayers = ref<Record<string, LayerProgress>>({});
const imageResults = ref<Record<string, 'success' | 'error' | 'cancelled'>>({});
const imageErrors = ref<Record<string, string>>({});
const imageRecreateStatus = ref<Record<string, { status: string; message: string }>>({});
const allDone = ref(false);
let cancelled = false;
let abortController: AbortController | null = null;

const completedCount = computed(() => Object.keys(imageResults.value).length);

function statusLabel(img: string): string {
  if (imageResults.value[img] === 'success') return 'Done';
  if (imageResults.value[img] === 'error') return 'Error';
  if (imageResults.value[img] === 'cancelled') return 'Skipped';
  if (currentImage.value === img) return 'Pulling';
  return 'Pending';
}

function statusLabelClass(img: string): string {
  if (imageResults.value[img] === 'success') return 'text-success';
  if (imageResults.value[img] === 'error') return 'text-error';
  if (imageResults.value[img] === 'cancelled') return 'text-text-secondary';
  if (currentImage.value === img) return 'text-primary';
  return 'text-text-secondary';
}

function imageState(img: string): 'pending' | 'running' | 'done' | 'error' | 'cancelled' {
  if (imageResults.value[img] === 'success') return 'done';
  if (imageResults.value[img] === 'error') return 'error';
  if (imageResults.value[img] === 'cancelled') return 'cancelled';
  if (currentImage.value === img) return 'running';
  return 'pending';
}

function imagePercent(img: string): number {
  if (imageResults.value[img] === 'success') return 100;
  if (imageResults.value[img] === 'error' || imageResults.value[img] === 'cancelled') return 100;
  if (currentImage.value === img) {
    const layerList = Object.values(currentLayers.value);
    if (layerList.length === 0) return 5;
    const avg = layerList.reduce((acc, l) => acc + l.percent, 0) / layerList.length;
    return Math.max(5, avg);
  }
  return 0;
}

function imageStatusText(img: string): string {
  if (imageResults.value[img] === 'success') return 'Done';
  if (imageResults.value[img] === 'error') return imageErrors.value[img] || 'Error';
  if (imageResults.value[img] === 'cancelled') return 'Skipped';
  if (currentImage.value === img) return currentStatus.value || 'Pulling...';
  return 'Pending';
}

function imageSublabel(img: string): string {
  const recreate = imageRecreateStatus.value[img];
  if (recreate) return recreate.message;
  return '';
}

function buildProgressItems() {
  return uniqueImages.value.map((img) => ({
    id: img,
    label: img,
    percent: imagePercent(img),
    status: imageStatusText(img),
    state: imageState(img),
    sublabel: imageSublabel(img),
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
    title: `Updating Containers (0/${uniqueImages.value.length})`,
    size: 'md',
    dismissable: false,
    fields: [
      { type: 'progress-list', id: 'images', items: buildProgressItems() },
    ],
    actions: [
      { id: 'cancel', label: 'Cancel', variant: 'default' },
    ],
  });
}

function modalTitle(): string {
  return allDone.value
    ? 'Update Complete'
    : `Updating Containers (${completedCount.value}/${uniqueImages.value.length})`;
}

function patchAll() {
  if (!inIframe) return;
  parentModal.update({
    title: modalTitle(),
    fields: [{ id: 'images', items: buildProgressItems() }],
  });
}

function patchImage(img: string) {
  if (!inIframe) return;
  parentModal.update({
    title: modalTitle(),
    fields: [
      {
        id: 'images',
        items: [
          {
            id: img,
            label: img,
            percent: imagePercent(img),
            status: imageStatusText(img),
            state: imageState(img),
            sublabel: imageSublabel(img),
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
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

function reset() {
  currentImage.value = null;
  currentStatus.value = '';
  currentLayers.value = {};
  imageResults.value = {};
  imageErrors.value = {};
  imageRecreateStatus.value = {};
  allDone.value = false;
  cancelled = false;
  abortController = null;
}

async function pullImage(image: string): Promise<'success' | 'error'> {
  currentImage.value = image;
  currentStatus.value = 'Preparing...';
  currentLayers.value = {};
  patchImage(image);

  abortController = new AbortController();

  const API_BASE = '/plugins/unraid-docker-folders-modern/api';
  const token = getCsrfToken();
  const body = new URLSearchParams();
  if (token) body.append('csrf_token', token);

  try {
    const response = await fetch(
      `${API_BASE}/pull.php?image=${encodeURIComponent(image)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: abortController.signal,
      },
    );

    if (!response.ok) return 'error';

    const reader = response.body?.getReader();
    if (!reader) return 'error';

    const decoder = new TextDecoder();
    let buffer = '';
    let result: 'success' | 'error' = 'error';

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
            const data = JSON.parse(line.slice(6));
            if (currentEvent === 'status') {
              currentStatus.value = data.message || 'Pulling...';
              patchImage(image);
            } else if (currentEvent === 'progress' && data.id) {
              const existing = currentLayers.value[data.id] || { status: '', current: 0, total: 0, percent: 0 };
              const current = data.current ?? existing.current;
              const total = data.total ?? existing.total;
              const percent = total > 0 ? Math.round((current / total) * 100) : (data.status === 'Pull complete' || data.status === 'Already exists' ? 100 : existing.percent);
              currentLayers.value[data.id] = { status: data.status || existing.status, current, total, percent };
              currentLayers.value = { ...currentLayers.value };
              patchImage(image);
            } else if (currentEvent === 'recreating') {
              currentStatus.value = data.message || `Recreating ${data.container}...`;
              imageRecreateStatus.value[image] = { status: 'recreating', message: data.message || '' };
              imageRecreateStatus.value = { ...imageRecreateStatus.value };
              patchImage(image);
            } else if (currentEvent === 'recreated') {
              currentStatus.value = data.message || `${data.container} updated`;
              imageRecreateStatus.value[image] = { status: 'recreated', message: data.message || '' };
              imageRecreateStatus.value = { ...imageRecreateStatus.value };
              patchImage(image);
            } else if (currentEvent === 'recreate_error') {
              imageRecreateStatus.value[image] = { status: 'recreate_error', message: data.message || '' };
              imageRecreateStatus.value = { ...imageRecreateStatus.value };
              patchImage(image);
            } else if (currentEvent === 'complete') {
              result = 'success';
            } else if (currentEvent === 'error') {
              imageErrors.value[image] = data.message || 'Pull failed';
              result = 'error';
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    return result;
  } catch (e: any) {
    if (e.name === 'AbortError') return 'error';
    imageErrors.value[image] = e.message || 'Pull failed';
    return 'error';
  }
}

async function startBatch() {
  reset();
  if (inIframe) openParent();

  for (const image of uniqueImages.value) {
    if (cancelled) {
      imageResults.value[image] = 'cancelled';
      imageResults.value = { ...imageResults.value };
      patchImage(image);
      continue;
    }

    const result = await pullImage(image);

    if (cancelled && result === 'error') {
      imageResults.value[image] = 'cancelled';
    } else {
      imageResults.value[image] = result;
    }
    imageResults.value = { ...imageResults.value };
    patchImage(image);
  }

  currentImage.value = null;
  currentStatus.value = '';
  currentLayers.value = {};
  allDone.value = true;
  patchAll();
  showCloseAction();
  emit('complete');
}

watch(() => props.isOpen, (open) => {
  if (open && props.containers.length > 0) {
    startBatch();
  } else if (!open) {
    cancelBatch();
    if (inIframe) parentModal.close();
  }
});
</script>
