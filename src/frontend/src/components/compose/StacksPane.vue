<template>
  <nav aria-label="Compose stacks" class="border border-border rounded bg-bg-card p-1">
    <div class="flex items-center justify-between px-2 pt-1.5 pb-1">
      <h2 class="text-[11px] font-bold uppercase text-text-secondary">Compose stacks</h2>
      <span class="text-[11px] text-text-secondary">{{ rows.length }}</span>
    </div>
    <p v-if="rows.length === 0" class="px-2 py-2 text-xs text-text-secondary">No compose stacks</p>
    <!-- The row is a div so the selected and hover tints apply: the button
         reset strips background and padding from a plain <button> (DESIGN.md
         §11), so the button carries no box of its own and its padding lives on
         the inner span. -->
    <div
      v-for="row in rows"
      :key="row.project"
      class="flex items-center gap-0.5 rounded transition-colors duration-150"
      :class="isSelected(row.project) ? 'bg-primary/15' : 'hover:bg-text/5'"
    >
      <button
        type="button"
        class="flex-1 min-w-0 text-left cursor-pointer text-text"
        :aria-pressed="isSelected(row.project)"
        :title="isSelected(row.project) ? 'Show all containers' : `Show only ${row.project}`"
        @click="toggle(row.project)"
      >
        <span class="flex items-center gap-2 py-1.5 pl-2 pr-1">
          <span
            class="shrink-0 inline-flex items-center justify-center min-w-6 h-5 px-1.5 rounded-full text-[11px] font-semibold"
            :class="row.running > 0 ? 'bg-primary text-primary-text' : 'bg-border text-text-secondary'"
            :title="`${row.running} running / ${row.total} total`"
          >{{ row.running }}/{{ row.total }}</span>
          <span class="flex flex-col min-w-0">
            <span class="text-sm font-semibold truncate">{{ row.project }}</span>
            <span
              class="text-[11px] truncate"
              :class="composeStore.stackActionStatus.get(row.project)?.error ? 'text-error' : 'text-text-secondary'"
              :title="statusLine(row)"
            >{{ statusLine(row) }}</span>
          </span>
        </span>
      </button>
      <KebabMenu
        :items="menuItems(row)"
        :button-title="`Actions for ${row.project}`"
        button-class="icon-btn text-text-secondary hover:text-text"
        no-wrap
        @select="(action) => handleSelect(row.project, action)"
      />
    </div>
  </nav>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useComposeStore, stackActionText } from '@/stores/compose';
import { useDockerStore, type Container } from '@/stores/docker';
import { useFolderStore } from '@/stores/folders';
import KebabMenu from '@/components/KebabMenu.vue';
import type { KebabMenuItem } from '@/components/KebabMenu.vue';
import { byLabel } from '@/utils/menu';
import { CLOSE_ICON, STOPWATCH_ICON, TRASH_ICON } from '@/utils/menuIcons';
import { stackActionItems } from '@/utils/stackMenu';
import { naturalNameCompare } from '@/utils/sortMode';

interface StackRow {
  project: string;
  running: number;
  total: number;
  location: string;
  /** Whether Docker Folders keeps a record of it. A project seen only on container labels has none to remove. */
  stored: boolean;
}

const emit = defineEmits<{
  'edit-compose': [project: string];
  'compose-up': [project: string];
  'compose-recompose': [project: string];
  'compose-down': [project: string];
  'compose-pull': [project: string];
  'compose-remove': [project: string];
  schedules: [targetType: string, targetId: string];
}>();

const composeStore = useComposeStore();
const dockerStore = useDockerStore();
const folderStore = useFolderStore();

/** How many folder names "In …" lists before it shortens to "+N more". */
const MAX_LISTED_FOLDERS = 2;

function isSelected(project: string): boolean {
  return dockerStore.stackFilter === project;
}

// Every known stack, plus any project seen only on container labels. Counts
// come from docker state, not `services_running`, which goes stale after an
// up or down (see useFolderRunningState).
const rows = computed<StackRow[]>(() => {
  const stored = new Set<string>(composeStore.stacks.map((s) => s.project_name));
  const projects = new Set<string>(stored);
  for (const project of dockerStore.containersByProject.keys()) projects.add(project);

  return [...projects].sort(naturalNameCompare).map((project) => {
    const members = dockerStore.containersInStack(project);
    return {
      project,
      running: members.filter((c) => c.state === 'running').length,
      total: members.length,
      location: locationText(members),
      stored: stored.has(project),
    };
  });
});

function locationText(members: Container[]): string {
  if (members.length === 0) return 'Not created';
  const names: string[] = [];
  for (const c of members) {
    const name = folderStore.folderByContainerName.get(c.name)?.name ?? 'Unfoldered';
    if (!names.includes(name)) names.push(name);
  }
  const listed = names.slice(0, MAX_LISTED_FOLDERS).join(', ');
  const rest = names.length - MAX_LISTED_FOLDERS;
  return rest > 0 ? `In ${listed} +${rest} more` : `In ${listed}`;
}

/** A stop or down in progress, or its failure, replaces the folder line. */
function statusLine(row: StackRow): string {
  const status = composeStore.stackActionStatus.get(row.project);
  return status ? stackActionText(status) : row.location;
}

function toggle(project: string) {
  dockerStore.stackFilter = dockerStore.stackFilter === project ? null : project;
}

// The same stack actions as the folder kebab (stackActionItems), plus
// Schedules, which the folder header has as a button, and Stack Down.
function menuItems(row: StackRow): KebabMenuItem[] {
  const disabled = composeStore.stackActionsDisabled(row.project);
  const reason = composeStore.stackDisabledReason(row.project);
  const items = stackActionItems({
    running: row.running > 0,
    disabled,
    reason,
    pluginInstalled: composeStore.composePluginInstalled,
  });
  items.push({ label: 'Schedules', icon: STOPWATCH_ICON, action: 'schedules' });
  return [
    ...byLabel(items),
    { divider: true },
    { label: 'Stack Down', icon: TRASH_ICON, action: 'compose-down', show: row.total > 0, disabled, title: reason, class: 'hover:text-error' },
    // Needs no Compose binary and no management: it only edits the plugin's own
    // records. It does wait for a stop, down or earlier removal still running.
    {
      label: 'Remove Stack',
      icon: CLOSE_ICON,
      action: 'compose-remove',
      show: row.stored,
      disabled: composeStore.isStackBusy(row.project),
      title: composeStore.isStackBusy(row.project) ? reason : 'Delete the stack\'s record from Docker Folders',
      class: 'hover:text-error',
    },
  ];
}

function handleSelect(project: string, action: string) {
  if (action === 'compose-up') emit('compose-up', project);
  else if (action === 'compose-pull') emit('compose-pull', project);
  else if (action === 'compose-recompose') emit('compose-recompose', project);
  else if (action === 'compose-edit') emit('edit-compose', project);
  else if (action === 'schedules') emit('schedules', 'stack', project);
  else if (action === 'compose-stop') composeStore.runStackAction(project, 'stop');
  else if (action === 'compose-down') emit('compose-down', project);
  else if (action === 'compose-remove') emit('compose-remove', project);
}
</script>
