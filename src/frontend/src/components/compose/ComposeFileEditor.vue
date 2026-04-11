<template>
  <BaseModal v-if="!inIframe" :is-open="isOpen" max-width="700px" fill-height @close="$emit('close')">
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
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from 'vue';
import { useComposeStore } from '@/stores/compose';
import { useParentModal } from '@/composables/useParentModal';
import BaseModal from '@/components/BaseModal.vue';

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

const emit = defineEmits<{ close: []; recompose: [project: string] }>();

const composeStore = useComposeStore();

type TabId = 'compose' | 'env' | 'logs';

const tabs = computed(() => {
  const base: { id: TabId; label: string }[] = [
    { id: 'compose', label: 'Compose File' },
    { id: 'env', label: 'Environment' },
  ];
  if (props.mode !== 'create') base.push({ id: 'logs', label: 'Logs' });
  return base;
});

const activeTab = ref<TabId>('compose');
const loading = ref(false);
const saving = ref(false);
const saveStatus = ref<string | null>(null);

const composeContent = ref('');
const composePath = ref<string | null>(null);
const envContent = ref('');
const envFilePath = ref<string | null>(null);
const envPath = ref('');
const originalEnvPath = ref('');

const logsContent = ref('');
const logsAutoRefresh = ref(true);
let logsPollTimer: number | null = null;

const DEFAULT_COMPOSE = 'version: "3.8"\nservices:\n  app:\n    image: \n    ports:\n      - "8080:80"\n';

const parentModal = useParentModal({
  onAction({ actionId, values, activeTab: tab }) {
    if (actionId === 'close' || actionId === 'cancel') {
      emit('close');
      return;
    }
    if (actionId === 'save' || actionId === 'save-recompose') {
      handleParentSave(actionId, values, tab);
    }
  },
  onFieldChange({ fieldId, itemId, value }) {
    if (fieldId === 'logsControls' && itemId === 'auto') {
      logsAutoRefresh.value = !!value;
      if (logsAutoRefresh.value) {
        startLogsPolling();
      } else {
        stopLogsPolling();
      }
    }
  },
});

const { inIframe } = parentModal;

function buildDescriptor() {
  const isCreate = props.mode === 'create';
  const title = isCreate
    ? 'Create Stack'
    : `${props.readOnly ? 'View' : 'Edit'} Compose - ${props.projectName}`;

  const fields: Parameters<typeof parentModal.open>[0]['fields'] = [];

  if (isCreate) {
    fields.push({
      type: 'input',
      id: 'projectName',
      label: 'Stack Name',
      value: '',
      placeholder: 'my-stack',
      autofocus: true,
      required: true,
    });
  }

  fields.push({
    type: 'textarea',
    id: 'composeContent',
    value: composeContent.value,
    caption: composePath.value || undefined,
    readOnly: props.readOnly,
    monospace: true,
    fillHeight: true,
    language: 'yaml',
    tab: 'compose',
  });

  fields.push({
    type: 'input',
    id: 'envPath',
    label: 'Env File Path',
    value: envPath.value,
    placeholder: '.env (default)',
    tab: 'env',
  });

  fields.push({
    type: 'textarea',
    id: 'envContent',
    value: envContent.value,
    caption: envFilePath.value || undefined,
    placeholder: 'KEY=value',
    readOnly: props.readOnly,
    monospace: true,
    fillHeight: true,
    tab: 'env',
  });

  if (!isCreate) {
    fields.push({
      type: 'checkbox-list',
      id: 'logsControls',
      items: [
        { id: 'auto', label: 'Auto-refresh every 3s', checked: logsAutoRefresh.value },
      ],
      tab: 'logs',
    });
    fields.push({
      type: 'log',
      id: 'logsContent',
      content: logsContent.value,
      fillHeight: true,
      tab: 'logs',
    });
  }

  const actions = buildActions();

  return {
    kind: isCreate ? 'compose-create' : 'compose-editor',
    title,
    size: 'xl' as const,
    fillHeight: true,
    tabs: tabs.value.map((t) => ({ id: t.id, label: t.label })),
    activeTab: 'compose',
    fields,
    actions,
  };
}

function buildActions(): Parameters<typeof parentModal.open>[0]['actions'] {
  const isCreate = props.mode === 'create';
  const actions: Parameters<typeof parentModal.open>[0]['actions'] = [];
  actions.push({
    id: 'close',
    label: props.readOnly ? 'Close' : 'Cancel',
    variant: 'default',
    disabled: saving.value,
  });
  if (!props.readOnly) {
    actions.push({
      id: 'save',
      label: saving.value ? (isCreate ? 'Creating...' : 'Saving...') : (isCreate ? 'Create' : 'Save'),
      variant: 'primary',
      disabledWhenEmpty: isCreate ? 'projectName' : undefined,
      disabled: saving.value,
    });
    if (!isCreate) {
      actions.push({
        id: 'save-recompose',
        label: saving.value ? 'Saving...' : 'Save & Recompose',
        variant: 'primary',
        disabled: saving.value,
      });
    }
  }
  return actions;
}

function patchActions() {
  if (inIframe) {
    parentModal.update({ actions: buildActions() });
  }
}

async function fetchLogsTick() {
  if (!props.projectName) return;
  try {
    const result = await composeStore.getLogs(props.projectName, 500);
    const next = result.output || result.error || '';
    if (next === logsContent.value) return;
    logsContent.value = next;
    if (inIframe) {
      parentModal.update({
        fields: [{ id: 'logsContent', content: next }],
      });
    }
  } catch (e) {
    console.error('Failed to fetch compose logs:', e);
  }
}

function startLogsPolling() {
  if (logsPollTimer != null) return;
  fetchLogsTick();
  logsPollTimer = window.setInterval(fetchLogsTick, 3000);
}

function stopLogsPolling() {
  if (logsPollTimer != null) {
    clearInterval(logsPollTimer);
    logsPollTimer = null;
  }
}

async function loadForEdit() {
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

    const stack = composeStore.getStackByProject(props.projectName);
    envPath.value = stack?.env_file || '';
    originalEnvPath.value = envPath.value;
  } catch (e) {
    console.error('Failed to load compose files:', e);
  } finally {
    loading.value = false;
  }
}

async function openForCurrentState() {
  activeTab.value = 'compose';
  saveStatus.value = null;
  logsContent.value = '';

  if (props.mode === 'create') {
    newProjectName.value = '';
    composeContent.value = DEFAULT_COMPOSE;
    composePath.value = null;
    envContent.value = '';
    envFilePath.value = null;
    envPath.value = '';
    originalEnvPath.value = '';
    loading.value = false;
  } else {
    await loadForEdit();
  }

  if (inIframe) {
    parentModal.open(buildDescriptor());
  }

  if (props.mode !== 'create' && logsAutoRefresh.value) {
    startLogsPolling();
  }
}

async function handleParentSave(
  actionId: string,
  values: Record<string, unknown>,
  tab: string | undefined,
) {
  saving.value = true;
  patchActions();

  try {
    if (props.mode === 'create') {
      const projectName = typeof values.projectName === 'string' ? values.projectName.trim() : '';
      if (!projectName) {
        parentModal.result(false, 'Stack name is required');
        return;
      }
      const content = typeof values.composeContent === 'string' ? values.composeContent : '';
      const env = typeof values.envContent === 'string' ? values.envContent : '';
      const result = await composeStore.createStack(projectName, content, env);
      parentModal.result(result.success, result.error || undefined);
      if (result.success) {
        const { useFolderStore } = await import('@/stores/folders');
        await useFolderStore().fetchFolders();
        setTimeout(() => emit('close'), 1200);
      }
      return;
    }

    // Edit mode — save whichever tab is active
    const currentTab = tab || 'compose';
    let success = true;
    try {
      if (currentTab === 'compose') {
        const content = typeof values.composeContent === 'string' ? values.composeContent : '';
        // Validate first; if invalid, mark bad lines in the editor and abort save.
        const validation = await composeStore.validateCompose(props.projectName, content);
        if (inIframe) {
          parentModal.update({
            fields: [
              {
                id: 'composeContent',
                ...(validation.success ? { clearErrors: true } : { errors: validation.errors }),
              },
            ],
          });
        }
        if (!validation.success) {
          parentModal.result(false, validation.errors[0]?.message || 'Invalid compose file');
          return;
        }
        success = await composeStore.saveComposeFile(props.projectName, content);
      } else {
        const content = typeof values.envContent === 'string' ? values.envContent : '';
        success = await composeStore.saveEnvFile(props.projectName, content);

        // Also persist env path if changed
        const newEnvPath = typeof values.envPath === 'string' ? values.envPath : '';
        if (success && newEnvPath !== originalEnvPath.value) {
          const ok = await composeStore.setEnvPath(props.projectName, newEnvPath);
          if (ok) originalEnvPath.value = newEnvPath;
        }
      }
    } catch {
      success = false;
    }
    parentModal.result(success, success ? undefined : 'Failed to save');
    if (success) {
      if (actionId === 'save-recompose') {
        emit('recompose', props.projectName);
        setTimeout(() => emit('close'), 200);
      } else {
        setTimeout(() => emit('close'), 600);
      }
    }
  } finally {
    saving.value = false;
    patchActions();
  }
}

watch(
  () => [props.isOpen, props.projectName, props.mode],
  () => {
    if (props.isOpen) {
      openForCurrentState();
    } else {
      stopLogsPolling();
      if (inIframe) parentModal.close();
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  stopLogsPolling();
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
        envContent.value,
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
        setTimeout(() => emit('close'), 600);
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
