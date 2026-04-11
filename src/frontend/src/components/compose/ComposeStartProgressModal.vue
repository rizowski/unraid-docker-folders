<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="672px" @close="handleClose">
          <div class="flex items-center justify-between px-6 py-4 border-b border-border">
            <div class="min-w-0">
              <h2 class="text-base font-semibold text-text truncate">Start Stack</h2>
              <p class="text-xs text-text-secondary font-mono truncate mt-0.5">{{ projectName }}</p>
            </div>
            <button
              v-if="isDone"
              @click="handleClose"
              class="p-1.5 border-none rounded cursor-pointer transition text-text-secondary hover:text-text shrink-0"
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div class="flex-1 overflow-hidden px-6 py-4 flex flex-col gap-3 min-h-0">
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

            <pre
              ref="logEl"
              class="flex-1 min-h-[200px] overflow-auto m-0 p-3 rounded text-xs font-mono whitespace-pre-wrap break-all bg-bg-card border border-border text-text-secondary"
            >{{ logText }}</pre>

            <div v-if="errorMessage" class="text-sm text-error bg-error/10 px-3 py-2 rounded">
              {{ errorMessage }}
            </div>
          </div>

          <div v-if="isDone" class="px-6 py-3 border-t border-border flex justify-end">
            <button
              @click="handleClose"
              class="px-4 py-1.5 bg-bg border border-border rounded cursor-pointer text-sm text-text hover:brightness-110 transition"
            >Close</button>
          </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { getCsrfToken } from '@/utils/csrf';
import { useParentModal } from '@/composables/useParentModal';
import BaseModal from '@/components/BaseModal.vue';

interface Props {
  isOpen: boolean;
  projectName: string;
  forceRecreate?: boolean;
}

const props = withDefaults(defineProps<Props>(), { forceRecreate: false });

const emit = defineEmits<{
  close: [];
  complete: [project: string];
}>();

const statusMessage = ref('Preparing...');
const errorMessage = ref('');
const isComplete = ref(false);
const isDone = ref(false);
const logLines = ref<string[]>([]);
const logText = computed(() => logLines.value.join('\n'));
const logEl = ref<HTMLPreElement | null>(null);
let abortController: AbortController | null = null;

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
    kind: 'compose-start-progress',
    title: `Start Stack — ${props.projectName}`,
    size: 'lg',
    fillHeight: true,
    dismissable: false,
    fields: [
      { type: 'status', id: 'status', message: statusMessage.value, spinner: true },
      { type: 'log', id: 'log', content: '', fillHeight: true },
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

function patchLog() {
  if (!inIframe) return;
  parentModal.update({
    fields: [{ id: 'log', content: logText.value }],
  });
}

function showCloseButton() {
  if (!inIframe) return;
  parentModal.update({
    dismissable: true,
    actions: [{ id: 'close', label: 'Close', variant: 'default' }],
  });
}

function appendLine(line: string) {
  logLines.value.push(line);
  // Cap to last 2000 lines to avoid runaway memory
  if (logLines.value.length > 2000) {
    logLines.value.splice(0, logLines.value.length - 2000);
  }
  patchLog();
  nextTick(() => {
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
  });
}

function reset() {
  statusMessage.value = 'Preparing...';
  errorMessage.value = '';
  isComplete.value = false;
  isDone.value = false;
  logLines.value = [];
}

function handleClose() {
  if (!isDone.value) return;
  emit('close');
}

async function startStream() {
  reset();
  if (inIframe) openParent();

  abortController = new AbortController();

  const API_BASE = '/plugins/unraid-docker-folders-modern/api';
  const token = getCsrfToken();
  const body = new URLSearchParams();
  if (token) body.append('csrf_token', token);
  if (props.forceRecreate) body.append('force_recreate', '1');

  try {
    const response = await fetch(
      `${API_BASE}/compose-stream.php?action=up&project=${encodeURIComponent(props.projectName)}`,
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
      const chunks = buffer.split('\n');
      buffer = chunks.pop() || '';

      let currentEvent = '';
      for (const line of chunks) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7);
        } else if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            handleSSEEvent(currentEvent, data);
          } catch {
            // skip malformed
          }
        }
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      errorMessage.value = e.message || 'Stack start failed';
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
      statusMessage.value = data.message || statusMessage.value;
      patchStatus();
      break;
    case 'phase':
      statusMessage.value = data.message || data.phase || statusMessage.value;
      patchStatus();
      // Also write a divider line into the log so users see phase boundaries
      appendLine(`▶ ${statusMessage.value}`);
      break;
    case 'log':
      if (typeof data.line === 'string') appendLine(data.line);
      break;
    case 'complete':
      statusMessage.value = data.message || 'Stack started';
      isComplete.value = true;
      patchStatus();
      emit('complete', props.projectName);
      break;
    case 'error':
      errorMessage.value = data.message || 'Failed';
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

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      startStream();
    } else {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      if (inIframe) parentModal.close();
    }
  },
);
</script>
