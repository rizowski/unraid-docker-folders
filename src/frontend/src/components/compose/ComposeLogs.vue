<template>
  <Transition name="modal">
  <div v-if="isOpen && !inIframe" class="absolute inset-0 z-[1000]" :style="{ minHeight: totalHeight + 'px' }">
    <div class="absolute inset-0 bg-black/50" @click="$emit('close')"></div>
    <div class="absolute flex items-center justify-center" :style="viewportStyle" @click="$emit('close')">
    <div class="modal-content bg-bg-card rounded-lg shadow-lg max-w-[800px] w-[95%] h-[85%] flex flex-col" @click.stop>
      <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border shrink-0">
        <h2 class="text-xl font-semibold text-text">Logs - {{ projectName }}</h2>
        <button class="flex items-center justify-center w-8 h-8 rounded-full border-none bg-transparent cursor-pointer text-text-secondary hover:text-text hover:bg-border transition" @click="$emit('close')" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="flex items-center gap-3 px-4 sm:px-6 py-2 border-b border-border shrink-0">
        <label class="flex items-center gap-2 text-sm text-text-secondary">
          Tail:
          <select v-model.number="tailCount" @change="fetchLogs" class="py-1 px-2 border border-border rounded bg-bg text-text text-sm cursor-pointer">
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
            <option :value="500">500</option>
          </select>
        </label>
        <label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input type="checkbox" v-model="autoRefresh" class="cursor-pointer" />
          Auto-refresh
        </label>
        <button
          @click="fetchLogs"
          :disabled="loading"
          class="nav-btn"
          :class="{ 'opacity-50 cursor-not-allowed': loading }"
        >
          {{ loading ? 'Loading...' : 'Refresh' }}
        </button>
      </div>

      <div class="flex-1 overflow-auto p-4 sm:p-6">
        <pre v-if="logOutput" class="text-xs font-mono text-text whitespace-pre-wrap break-all leading-relaxed m-0">{{ logOutput }}</pre>
        <div v-else-if="loading" class="text-center py-8 text-text-secondary">Loading logs...</div>
        <div v-else class="text-center py-8 text-text-secondary">No logs available</div>
        <div v-if="logError" class="mt-2 text-sm text-error">{{ logError }}</div>
      </div>

      <div class="flex justify-end p-4 sm:p-6 border-t border-border shrink-0">
        <button @click="$emit('close')" class="nav-btn">Close</button>
      </div>
    </div>
    </div>
  </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue';
import { useComposeStore } from '@/stores/compose';
import { useParentViewport } from '@/composables/useParentViewport';
import { useParentModal } from '@/composables/useParentModal';

interface Props {
  isOpen: boolean;
  projectName: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{ close: [] }>();

const composeStore = useComposeStore();

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

const loading = ref(false);
const logOutput = ref('');
const logError = ref<string | null>(null);
const tailCount = ref(100);
const autoRefresh = ref(false);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const parentModal = useParentModal({
  onAction({ actionId, values }) {
    if (actionId === 'close') {
      emit('close');
      return;
    }
    if (actionId === 'refresh') {
      const tail = values.tail;
      if (tail != null) tailCount.value = Number(tail) || 100;
      const auto = values.autoRefresh;
      // checkbox-list returns a string[] of checked ids
      if (Array.isArray(auto)) autoRefresh.value = auto.includes('on');
      fetchLogs();
    }
  },
});

const { inIframe } = parentModal;

function openParent() {
  parentModal.open({
    kind: 'compose-logs',
    title: `Logs - ${props.projectName}`,
    size: 'lg',
    fillHeight: true,
    fields: [
      {
        type: 'select',
        id: 'tail',
        label: 'Tail',
        value: tailCount.value,
        options: [
          { value: 50, label: '50 lines' },
          { value: 100, label: '100 lines' },
          { value: 200, label: '200 lines' },
          { value: 500, label: '500 lines' },
        ],
      },
      {
        type: 'checkbox-list',
        id: 'autoRefresh',
        items: [{ id: 'on', label: 'Auto-refresh (every 5s)', checked: autoRefresh.value }],
      },
      {
        type: 'log',
        id: 'log',
        content: logOutput.value || (loading.value ? 'Loading logs...' : 'No logs available'),
        fillHeight: true,
      },
    ],
    actions: [
      { id: 'refresh', label: 'Refresh', variant: 'default' },
      { id: 'close', label: 'Close', variant: 'primary' },
    ],
  });
}

function patchLogContent() {
  if (!inIframe) return;
  parentModal.update({
    fields: [
      {
        id: 'log',
        content: logError.value
          ? `${logOutput.value || ''}\n\n[Error] ${logError.value}`
          : logOutput.value || (loading.value ? 'Loading logs...' : 'No logs available'),
      },
    ],
  });
}

async function fetchLogs() {
  if (!props.projectName) return;

  loading.value = true;
  logError.value = null;
  patchLogContent();

  try {
    const result = await composeStore.getLogs(props.projectName, tailCount.value);
    logOutput.value = result.output;
    if (result.error) {
      logError.value = result.error;
    }
  } finally {
    loading.value = false;
    patchLogContent();
  }
}

watch(() => [props.isOpen, props.projectName], () => {
  if (props.isOpen && props.projectName) {
    if (inIframe) openParent();
    fetchLogs();
  } else {
    logOutput.value = '';
    logError.value = null;
    if (inIframe && !props.isOpen) parentModal.close();
  }
}, { immediate: true });

watch(autoRefresh, (enabled) => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (enabled) {
    refreshTimer = setInterval(fetchLogs, 5000);
  }
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});
</script>
