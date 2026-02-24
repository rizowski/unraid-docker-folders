<template>
  <Teleport to="body">
    <div v-if="isOpen" class="modal-enter fixed inset-0 z-[1000] flex items-center justify-center p-4">
      <div class="fixed inset-0 bg-black/50" @click="handleClose"></div>
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
            <!-- Status icon -->
            <div class="shrink-0 mt-0.5">
              <!-- Done (success) -->
              <svg v-if="imageResults[img] === 'success'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-success">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <!-- Done (error) -->
              <svg v-else-if="imageResults[img] === 'error'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-error">
                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <!-- Cancelled -->
              <svg v-else-if="imageResults[img] === 'cancelled'" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-text-secondary">
                <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              <!-- In progress -->
              <svg v-else-if="currentImage === img" class="animate-spin h-4 w-4 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              <!-- Pending -->
              <div v-else class="w-4 h-4 rounded-full border-2 border-border"></div>
            </div>

            <div class="flex-1 min-w-0">
              <p class="text-sm text-text font-mono truncate">{{ img }}</p>
              <!-- Layer progress for current image -->
              <div v-if="currentImage === img && Object.keys(currentLayers).length > 0" class="mt-1.5 space-y-1">
                <div v-for="(layer, layerId) in currentLayers" :key="layerId" class="flex items-center gap-2 text-xs">
                  <span class="text-text-secondary font-mono w-16 shrink-0 truncate">{{ layerId }}</span>
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
              <!-- Status text -->
              <p v-if="currentImage === img && currentStatus" class="text-xs text-text-secondary mt-1">{{ currentStatus }}</p>
              <p v-if="imageErrors[img]" class="text-xs text-error mt-1">{{ imageErrors[img] }}</p>

              <!-- Post-pull actions per image -->
              <div v-if="imageResults[img] === 'success' && postPullAction !== 'pull_only'" class="mt-1.5">
                <template v-if="postPullAction === 'pull_and_offer_restart'">
                  <div v-for="c in getContainersForImage(img)" :key="c.name" class="inline-flex items-center gap-1 mr-2">
                    <span class="text-xs text-text-secondary">{{ c.name }}</span>
                    <a
                      v-if="c.managed === 'dockerman'"
                      :href="`/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-${c.name}.xml`"
                      class="text-xs text-primary hover:underline"
                    >Apply Update</a>
                  </div>
                </template>
              </div>
            </div>

            <!-- Status label -->
            <span class="shrink-0 text-xs font-medium" :class="statusLabelClass(img)">
              {{ statusLabel(img) }}
            </span>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-6 py-3 border-t border-border flex justify-between items-center">
          <div v-if="allDone && successCount > 0 && postPullAction === 'pull_only'" class="text-xs text-text-secondary">
            {{ successCount }} image{{ successCount > 1 ? 's' : '' }} pulled. Use "Apply Update" in Unraid to recreate containers.
          </div>
          <div v-else></div>
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
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { getCsrfToken } from '@/utils/csrf';
import { useSettingsStore } from '@/stores/settings';

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

const settingsStore = useSettingsStore();
const postPullAction = computed(() => settingsStore.postPullAction);

// Deduplicated list of unique images to pull
const uniqueImages = computed(() => [...new Set(props.containers.map((c) => c.image))]);

const currentImage = ref<string | null>(null);
const currentStatus = ref('');
const currentLayers = ref<Record<string, LayerProgress>>({});
const imageResults = ref<Record<string, 'success' | 'error' | 'cancelled'>>({});
const imageErrors = ref<Record<string, string>>({});
const allDone = ref(false);
let cancelled = false;
let abortController: AbortController | null = null;

const completedCount = computed(() => Object.keys(imageResults.value).length);
const successCount = computed(() => Object.values(imageResults.value).filter((r) => r === 'success').length);

function getContainersForImage(image: string): PullContainer[] {
  return props.containers.filter((c) => c.image === image);
}

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
  allDone.value = false;
  cancelled = false;
  abortController = null;
}

async function pullImage(image: string): Promise<'success' | 'error'> {
  currentImage.value = image;
  currentStatus.value = 'Preparing...';
  currentLayers.value = {};

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

    if (!response.ok) {
      return 'error';
    }

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
            } else if (currentEvent === 'progress' && data.id) {
              const existing = currentLayers.value[data.id] || { status: '', current: 0, total: 0, percent: 0 };
              const current = data.current ?? existing.current;
              const total = data.total ?? existing.total;
              const percent = total > 0 ? Math.round((current / total) * 100) : (data.status === 'Pull complete' || data.status === 'Already exists' ? 100 : existing.percent);
              currentLayers.value[data.id] = { status: data.status || existing.status, current, total, percent };
              currentLayers.value = { ...currentLayers.value };
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
    if (e.name === 'AbortError') {
      return 'error';
    }
    imageErrors.value[image] = e.message || 'Pull failed';
    return 'error';
  }
}

async function startBatch() {
  reset();

  for (const image of uniqueImages.value) {
    if (cancelled) {
      // Mark remaining as cancelled
      imageResults.value[image] = 'cancelled';
      imageResults.value = { ...imageResults.value };
      continue;
    }

    const result = await pullImage(image);

    if (cancelled && result === 'error') {
      imageResults.value[image] = 'cancelled';
    } else {
      imageResults.value[image] = result;
    }
    imageResults.value = { ...imageResults.value };
  }

  currentImage.value = null;
  currentStatus.value = '';
  currentLayers.value = {};
  allDone.value = true;
  emit('complete');
}

watch(() => props.isOpen, (open) => {
  if (open && props.containers.length > 0) {
    startBatch();
  } else if (!open) {
    cancelBatch();
  }
});
</script>
