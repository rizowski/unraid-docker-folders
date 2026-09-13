<template>
  <div class="widget-row flex items-center gap-2 py-1 pl-2 pr-1 min-w-0" :class="{ 'opacity-60': busy }">
    <ContainerIcon
      :src="container.icon || fallbackIcon"
      :alt="container.name"
      :halo-class="status.halo"
      :status-tooltip="status.tooltip"
      :href="null"
    />
    <span class="flex-1 min-w-0 text-sm text-text truncate" :title="container.name">{{ container.name }}</span>
    <svg
      v-if="busy"
      class="animate-spin h-3.5 w-3.5 shrink-0 text-text-secondary"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-label="Working"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
    </svg>
    <KebabMenu
      :items="menuItems"
      :fit-viewport="false"
      :icon-size="14"
      button-class="icon-btn text-text-secondary hover:text-text"
      :button-title="`Actions for ${container.name}`"
      @select="onSelect"
      @open-change="(open, bottom) => emit('menu-open-change', open, bottom)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import ContainerIcon from '@/components/docker/ContainerIcon.vue';
import KebabMenu, { type KebabMenuItem } from '@/components/KebabMenu.vue';
import { useDockerStore, type Container } from '@/stores/docker';
import { containerEditUrl, containerStatus, openContainerTerminal } from '@/utils/containerDisplay';

const props = defineProps<{
  container: Container;
  distinguishHealthy: boolean;
}>();

const emit = defineEmits<{
  'menu-open-change': [open: boolean, bottom: number];
}>();

const dockerStore = useDockerStore();
const fallbackIcon = `${import.meta.env.BASE_URL}docker.svg`;

const busy = ref(false);

const status = computed(() => containerStatus(props.container, props.distinguishHealthy));
const isRunning = computed(() => props.container.state === 'running');
const isPaused = computed(() => props.container.state === 'paused');
const isCompose = computed(() => !!props.container.labels?.['com.docker.compose.project']);
const editUrl = computed(() => containerEditUrl(props.container));

const menuItems = computed<KebabMenuItem[]>(() => [
  { label: 'Start', icon: 'M6 4l14 8-14 8z', action: 'start', class: 'text-success', show: !isRunning.value && !isPaused.value, disabled: busy.value },
  { label: 'Resume', icon: 'M6 4l14 8-14 8z', action: 'resume', class: 'text-success', show: isPaused.value, disabled: busy.value },
  { label: 'Stop', icon: 'M6 6h12v12H6z', action: 'stop', class: 'text-error', show: isRunning.value, disabled: busy.value },
  // `href` is empty for an unmanaged container, so KebabMenu falls through to
  // its button branch, which is the only one that honours disabled/title.
  {
    label: 'Edit',
    icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7|M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
    href: editUrl.value || '',
    disabled: !editUrl.value,
    title: editUrl.value ? undefined : 'Only available for containers that Unraid manages.',
  },
  { label: 'Logs', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6|M16 13H8|M16 17H8|M10 9H8', action: 'logs', show: !isCompose.value },
]);

async function run(action: (id: string) => Promise<boolean>) {
  busy.value = true;
  try {
    await action(props.container.id);
  } finally {
    busy.value = false;
  }
}

function onSelect(action: string) {
  if (action === 'start') void run(dockerStore.startContainer);
  else if (action === 'resume') void run(dockerStore.resumeContainer);
  else if (action === 'stop') void run(dockerStore.stopContainer);
  else if (action === 'logs') openContainerTerminal(props.container.name, 'logs');
}
</script>
