<template>
  <Transition name="modal">
  <div v-if="isOpen" class="absolute inset-0 z-[1000]" :style="{ minHeight: totalHeight + 'px' }">
    <!-- Full-document dark backdrop -->
    <div class="absolute inset-0 bg-black/50" @click="$emit('close')"></div>
    <!-- Modal centered in visible viewport -->
    <div class="absolute flex items-center justify-center" :style="viewportStyle" @click="$emit('close')">
    <div class="modal-content bg-bg-card rounded-lg shadow-lg max-w-[700px] w-[95%] flex flex-col" :style="{ maxHeight: (visibleHeight * 0.85) + 'px' }" @click.stop>
      <!-- Header -->
      <div class="flex justify-between items-center p-4 sm:p-6 border-b border-border shrink-0">
        <h2 class="text-xl font-semibold text-text">{{ readOnly ? 'View' : 'Edit' }} Compose - {{ projectName }}</h2>
        <button class="flex items-center justify-center w-8 h-8 rounded-full border-none bg-transparent cursor-pointer text-text-secondary hover:text-text hover:bg-border transition" @click="$emit('close')" aria-label="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <!-- Tabs -->
      <div class="flex shrink-0 border-b border-border px-2">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="activeTab = tab.id"
          class="px-4 py-2 text-sm font-medium cursor-pointer transition-colors -mb-px"
          :class="activeTab === tab.id
            ? 'text-text bg-bg border border-border border-b-bg-card rounded-t-md'
            : 'text-text-secondary hover:text-text bg-transparent border border-transparent hover:bg-bg/50 rounded-t-md'"
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
            class="w-full flex-1 min-h-[120px] p-3 border border-border rounded bg-bg text-text text-sm font-mono resize-y focus:outline-none focus:border-primary box-border"
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
                class="flex-1 py-1.5 px-3 border border-border rounded bg-bg text-text text-sm font-mono focus:outline-none focus:border-primary"
                :class="{ 'opacity-70': readOnly }"
              />
              <button
                v-if="!readOnly && envPath !== originalEnvPath"
                @click="saveEnvPath"
                class="px-3 py-1.5 rounded text-xs font-medium cursor-pointer bg-primary text-primary-text border-none hover:brightness-90 transition"
              >Save Path</button>
            </div>
          </div>
          <div v-if="envFilePath" class="text-xs text-text-secondary mb-2 font-mono truncate">{{ envFilePath }}</div>
          <textarea
            v-model="envContent"
            :readonly="readOnly"
            class="w-full flex-1 min-h-[120px] p-3 border border-border rounded bg-bg text-text text-sm font-mono resize-y focus:outline-none focus:border-primary box-border"
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
          <button type="button" @click="$emit('close')" class="py-2 px-6 border-none rounded text-sm font-medium cursor-pointer bg-border text-text hover:brightness-90 transition">
            {{ readOnly ? 'Close' : 'Cancel' }}
          </button>
          <button
            v-if="!readOnly"
            @click="handleSave"
            :disabled="saving"
            class="py-2 px-6 border-none rounded text-sm font-medium cursor-pointer bg-button text-button-text hover:bg-button-hover transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
    </div>
  </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useComposeStore } from '@/stores/compose';
import { useParentViewport } from '@/composables/useParentViewport';

interface Props {
  isOpen: boolean;
  projectName: string;
  readOnly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  readOnly: false,
});

defineEmits<{ close: [] }>();

const composeStore = useComposeStore();

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

watch(() => [props.isOpen, props.projectName], async () => {
  if (!props.isOpen || !props.projectName) return;

  activeTab.value = 'compose';
  saveStatus.value = null;
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
  } catch (e) {
    console.error('Failed to load compose files:', e);
  } finally {
    loading.value = false;
  }
}, { immediate: true });

async function handleSave() {
  saving.value = true;
  saveStatus.value = null;

  try {
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
