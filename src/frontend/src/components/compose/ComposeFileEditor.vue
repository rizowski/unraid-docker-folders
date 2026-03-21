<template>
  <Transition name="modal">
  <div v-if="isOpen && !useParentModal" class="absolute inset-0 z-[1000]" :style="{ minHeight: totalHeight + 'px' }">
    <!-- Full-document dark backdrop -->
    <div class="absolute inset-0 bg-black/50" @click="$emit('close')"></div>
    <!-- Modal centered in visible viewport -->
    <div class="absolute flex items-center justify-center" :style="viewportStyle" @click="$emit('close')">
    <div class="modal-content bg-bg-card rounded-lg shadow-lg max-w-[700px] w-[95%] h-[85%] flex flex-col" @click.stop>
      <!-- Header -->
      <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border shrink-0">
        <div v-if="mode === 'create'" class="flex items-center gap-3 flex-1 mr-4">
          <h2 class="text-xl font-semibold text-text shrink-0">Create Stack</h2>
          <input
            v-model="newProjectName"
            type="text"
            placeholder="Stack name"
            class="styled-input flex-1"
          />
        </div>
        <h2 v-else class="text-xl font-semibold text-text">{{ readOnly ? 'View' : 'Edit' }} Compose - {{ projectName }}</h2>
        <button class="flex items-center justify-center w-8 h-8 rounded-full border-none bg-transparent cursor-pointer text-text-secondary hover:text-text hover:bg-border transition" @click="$emit('close')" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex shrink-0 gap-2 px-4 sm:px-6 py-2 border-b border-border">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="activeTab = tab.id"
          class="nav-btn"
          :class="{ active: activeTab === tab.id }"
        >{{ tab.label }}</button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto p-4 sm:p-6 flex flex-col min-h-0">
        <div v-if="loading" class="text-center py-8 text-text-secondary">Loading...</div>

        <div v-else-if="activeTab === 'compose'" class="flex flex-col flex-1 min-h-0">
          <div v-if="composePath" class="text-xs text-text-secondary mb-2 font-mono truncate">{{ composePath }}</div>
          <textarea
            v-model="composeContent"
            :readonly="readOnly"
            class="styled-input flex-1 min-h-[120px]"
            :class="{ 'opacity-70': readOnly }"
            spellcheck="false"
          ></textarea>
        </div>

        <div v-else-if="activeTab === 'env'" class="flex flex-col flex-1 min-h-0">
          <div class="mb-3">
            <label class="block mb-1 text-sm font-medium text-text">Env File Path</label>
            <div class="flex gap-2">
              <input
                v-model="envPath"
                type="text"
                :readonly="readOnly"
                placeholder=".env (default)"
                class="styled-input flex-1"
                :class="{ 'opacity-70': readOnly }"
              />
              <button
                v-if="!readOnly && envPath !== originalEnvPath"
                @click="saveEnvPath"
                class="nav-btn active"
              >Save Path</button>
            </div>
          </div>
          <div v-if="envFilePath" class="text-xs text-text-secondary mb-2 font-mono truncate">{{ envFilePath }}</div>
          <textarea
            v-model="envContent"
            :readonly="readOnly"
            class="styled-input flex-1 min-h-[120px]"
            :class="{ 'opacity-70': readOnly }"
            placeholder="KEY=value"
            spellcheck="false"
          ></textarea>
        </div>
      </div>

      <!-- Footer -->
      <div class="flex justify-between items-center gap-2 p-4 sm:p-6 border-t border-border shrink-0">
        <span v-if="saveStatus" class="text-sm" :class="saveStatus === 'saved' ? 'text-green-400' : 'text-error'">
          {{ saveStatus === 'saved' ? 'Saved' : saveStatus }}
        </span>
        <span v-else></span>
        <div class="flex gap-2">
          <button type="button" @click="$emit('close')" class="nav-btn">
            {{ readOnly ? 'Close' : 'Cancel' }}
          </button>
          <button
            v-if="!readOnly"
            @click="handleSave"
            :disabled="saving"
            class="nav-btn active"
            :class="{ 'opacity-50 cursor-not-allowed': saving }"
          >
            {{ saving ? (mode === 'create' ? 'Creating...' : 'Saving...') : (mode === 'create' ? 'Create' : 'Save') }}
          </button>
        </div>
      </div>
    </div>
    </div>
  </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useComposeStore } from '@/stores/compose';
import { useParentViewport } from '@/composables/useParentViewport';

interface Props {
  isOpen: boolean;
  projectName: string;
  readOnly?: boolean;
  mode?: 'edit' | 'create';
}

const props = withDefaults(defineProps<Props>(), {
  readOnly: false,
  mode: 'edit',
});

const newProjectName = ref('');

const emit = defineEmits<{ close: [] }>();

const composeStore = useComposeStore();
const inIframe = window.parent !== window;

// Viewport tracking (only used for in-iframe fallback rendering)
const { visibleTop, visibleHeight } = useParentViewport();
const totalHeight = computed(() =>
  Math.max(document.documentElement.scrollHeight, visibleTop.value + visibleHeight.value)
);
const viewportStyle = computed(() => ({
  top: visibleTop.value + 'px',
  left: '0',
  width: '100%',
  height: visibleHeight.value + 'px',
}));

// When in iframe, the modal renders in the parent page DOM.
// This flag controls whether the local template renders.
const useParentModal = inIframe;

const tabs = [
  { id: 'compose' as const, label: 'Compose File' },
  { id: 'env' as const, label: 'Environment' },
];

const activeTab = ref<'compose' | 'env'>('compose');
const loading = ref(false);
const saving = ref(false);
const saveStatus = ref<string | null>(null);

const composeContent = ref('');
const composePath = ref<string | null>(null);
const envContent = ref('');
const envFilePath = ref<string | null>(null);
const envPath = ref('');
const originalEnvPath = ref('');

watch(() => [props.isOpen, props.projectName, props.mode], async () => {
  if (!props.isOpen) return;

  activeTab.value = 'compose';
  saveStatus.value = null;

  // Create mode: set defaults, no data to fetch
  if (props.mode === 'create') {
    newProjectName.value = '';
    composeContent.value = "version: \"3.8\"\nservices:\n  app:\n    image: \n    ports:\n      - \"8080:80\"\n";
    composePath.value = null;
    envContent.value = '';
    envFilePath.value = null;
    envPath.value = '';
    originalEnvPath.value = '';
    loading.value = false;

    if (useParentModal) {
      window.parent.postMessage({
        type: 'docker-folders-modal',
        open: true,
        modal: {
          kind: 'compose-create',
          title: 'Create Stack',
          readOnly: false,
          projectName: '',
          composeContent: composeContent.value,
          composePath: null,
          envContent: '',
          envPath: '',
          envFilePath: null,
        }
      }, '*');
    }
    return;
  }

  // Edit mode: fetch existing data
  if (!props.projectName) return;
  loading.value = true;

  try {
    const [composeResult, envResult] = await Promise.all([
      composeStore.getComposeFile(props.projectName),
      composeStore.getEnvFile(props.projectName),
    ]);

    composeContent.value = composeResult.content || '';
    composePath.value = composeResult.path;
    envContent.value = envResult.content || '';
    envFilePath.value = envResult.path;

    // Load env path from stack metadata
    const stack = composeStore.getStackByProject(props.projectName);
    envPath.value = stack?.env_file || '';
    originalEnvPath.value = envPath.value;

    // If in iframe, send data to parent page modal
    if (useParentModal) {
      window.parent.postMessage({
        type: 'docker-folders-modal',
        open: true,
        modal: {
          kind: 'compose-editor',
          title: (props.readOnly ? 'View' : 'Edit') + ' Compose - ' + props.projectName,
          readOnly: props.readOnly,
          projectName: props.projectName,
          composeContent: composeContent.value,
          composePath: composePath.value,
          envContent: envContent.value,
          envPath: envPath.value,
          envFilePath: envFilePath.value,
        }
      }, '*');
    }
  } catch (e) {
    console.error('Failed to load compose files:', e);
  } finally {
    loading.value = false;
  }
}, { immediate: true });

// Listen for parent modal actions (save/close)
function handleParentMessage(e: MessageEvent) {
  if (!e.data || e.data.type !== 'docker-folders-modal-action') return;

  if (e.data.action === 'close') {
    emit('close');
  } else if (e.data.action === 'create' && e.data.projectName) {
    handleParentCreate(e.data.projectName, e.data.composeContent, e.data.envContent);
  } else if (e.data.action === 'save' && e.data.projectName) {
    handleParentSave(e.data.tab, e.data.content, e.data.projectName);
  }
}

async function handleParentCreate(projectName: string, composeContent: string, envContent: string) {
  const { useFolderStore } = await import('@/stores/folders');
  const result = await composeStore.createStack(projectName, composeContent, envContent);
  window.parent.postMessage({
    type: 'docker-folders-modal-result',
    success: result.success,
    error: result.error || null,
  }, '*');
  if (result.success) {
    await useFolderStore().fetchFolders();
    setTimeout(() => emit('close'), 1500);
  }
}

async function handleParentSave(tab: string, content: string, projectName: string) {
  let success = true;
  try {
    if (tab === 'compose') {
      success = await composeStore.saveComposeFile(projectName, content);
    } else {
      success = await composeStore.saveEnvFile(projectName, content);
    }
  } catch {
    success = false;
  }
  // Send result back to parent modal
  window.parent.postMessage({
    type: 'docker-folders-modal-result',
    success,
    error: success ? null : 'Failed to save',
  }, '*');
}

onMounted(() => {
  if (useParentModal) {
    window.addEventListener('message', handleParentMessage);
  }
});

onUnmounted(() => {
  if (useParentModal) {
    window.removeEventListener('message', handleParentMessage);
  }
});

// Close parent modal when isOpen goes false
watch(() => props.isOpen, (open) => {
  if (!open && useParentModal) {
    window.parent.postMessage({ type: 'docker-folders-modal', open: false }, '*');
  }
});

async function handleSave() {
  saving.value = true;
  saveStatus.value = null;

  try {
    if (props.mode === 'create') {
      if (!newProjectName.value.trim()) {
        saveStatus.value = 'Project name is required';
        return;
      }
      const result = await composeStore.createStack(
        newProjectName.value.trim(),
        composeContent.value,
        envContent.value
      );
      saveStatus.value = result.success ? 'saved' : (result.error || 'Failed to create');
      if (result.success) {
        const { useFolderStore } = await import('@/stores/folders');
        await useFolderStore().fetchFolders();
        setTimeout(() => emit('close'), 1500);
      }
    } else {
      let success = true;
      if (activeTab.value === 'compose') {
        success = await composeStore.saveComposeFile(props.projectName, composeContent.value);
      } else {
        success = await composeStore.saveEnvFile(props.projectName, envContent.value);
      }
      saveStatus.value = success ? 'saved' : 'Failed to save';
      if (success) {
        setTimeout(() => { saveStatus.value = null; }, 2000);
      }
    }
  } finally {
    saving.value = false;
  }
}

async function saveEnvPath() {
  const success = await composeStore.setEnvPath(props.projectName, envPath.value);
  if (success) {
    originalEnvPath.value = envPath.value;
  }
}
</script>
