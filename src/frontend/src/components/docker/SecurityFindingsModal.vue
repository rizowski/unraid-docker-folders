<template>
  <BaseModal :is-open="isOpen" max-width="640px" @close="$emit('close')">
    <div class="px-6 py-4 border-b border-border">
      <h2 class="text-base font-semibold text-text">{{ heading }}</h2>
      <p class="text-sm text-text-secondary mt-1">
        Settings that give a container more of the server than it usually needs,
        and folders two containers write as users that cannot read each other's
        files. Nothing here is changed for you, and where the plugin can tell
        what to put back, the finding says so in Unraid's own wording.
      </p>
    </div>

    <div class="max-h-[420px] overflow-auto px-6 py-4">
      <p v-if="rows.length === 0 && folderRows.length === 0" class="text-sm text-text-secondary">
        {{ emptyText }}
      </p>

      <!-- Folder clashes read once, by folder. The same clash seen from each
           container says the same thing twice, mirrored, which is what made the
           per-container list hard to scan. -->
      <section v-if="folderRows.length > 0" class="mb-5">
        <h3 class="text-[10px] font-semibold uppercase tracking-wide text-text-secondary border-b border-border pb-1 mb-2">
          Shared folder conflicts
        </h3>

        <div
          v-for="conflict in folderRows"
          :key="conflict.path"
          class="mb-3 last:mb-0"
        >
          <!-- The same strip the container sections wear, so the panel reads as
               a list of headings. Centered, not top-aligned: the button is 36px
               tall and the path is one line of text-xs, so a shared top edge
               leaves the path against the button's cap, not beside its label. -->
          <div
            class="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-bg-card hover:bg-bg-input cursor-pointer select-none transition-colors duration-200"
            @click="toggleConflict(conflict.path)"
          >
            <ChevronIcon :expanded="isOpenConflict(conflict.path)" />
            <p class="flex-1 min-w-0 font-mono text-xs break-all text-text">{{ conflict.path }}</p>
            <!-- Collapsed, the count says how many containers stand on the
                 folder, which is the number that decides whether to look. -->
            <span
              class="shrink-0 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold bg-warning/20 text-warning"
              :title="`${conflict.writers.length} containers write this folder`"
            >{{ conflict.writers.length }}</span>
            <button
              type="button"
              class="nav-btn shrink-0"
              title="Accept this folder and hide it, for every container on it"
              @click.stop="dismissConflict(conflict)"
            >Dismiss</button>
          </div>

          <template v-if="isOpenConflict(conflict.path)">
            <div
              v-for="writer in conflict.writers"
              :key="writer.container"
              class="flex items-center gap-2 mt-2 px-2 text-xs first:mt-3"
            >
              <img
                :src="iconFor(writer.container)"
                :alt="writer.container"
                class="shrink-0 w-4 h-4 object-contain"
              />
              <span class="min-w-0 truncate text-text">{{ writer.container }}</span>
              <span class="ml-auto shrink-0 font-mono text-[11px] text-text-secondary">
                {{ describeWriter(writer) }}
              </span>
            </div>

            <p class="mt-2 px-2 text-xs text-text-secondary">{{ conflictReason(conflict) }}</p>
          </template>
        </div>
      </section>

      <!-- The folder section owns the top of the panel, so the per-container
           list needs to say where it starts and what it holds. Same label type
           as the conflicts above it. -->
      <h3
        v-if="rows.length > 0"
        class="text-[10px] font-semibold uppercase tracking-wide text-text-secondary border-b border-border pb-1 mb-2"
      >
        Container settings
      </h3>

      <div v-for="row in rows" :key="row.container.id" class="mb-3 last:mb-0">
        <!-- A tinted strip, the same shape a folder header uses, so a panel
             listing six containers reads as six things rather than as one
             column of text. Clicking it collapses the container's findings. -->
        <h3
          class="flex items-center gap-2 px-2 py-1.5 rounded border border-border bg-bg-card hover:bg-bg-input cursor-pointer select-none text-sm font-semibold text-text transition-colors duration-200"
          @click="toggleSection(row.container.id)"
        >
          <ChevronIcon :expanded="isOpenSection(row.container.id)" />
          <!-- A plain img, not ContainerIcon: the halo means running state and
               every row here is running, so it would be decoration. -->
          <img
            :src="row.container.icon || FALLBACK_CONTAINER_ICON"
            :alt="row.container.name"
            class="shrink-0 w-5 h-5 object-contain"
          />
          <span class="truncate min-w-0">{{ row.container.name }}</span>
          <!-- Collapsed, the count is the only thing left saying how much is
               here, so it carries the worst severity on the row. -->
          <span
            class="shrink-0 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold"
            :class="row.worst === 'critical' ? 'bg-error/15 text-error' : 'bg-warning/20 text-warning'"
            :title="`${row.findings.length} finding${row.findings.length === 1 ? '' : 's'}`"
          >{{ row.findings.length }}</span>
          <!-- The image page documents the ports and variables this panel keeps
               telling people to go and check, so it belongs on the container,
               not on one finding. -->
          <span
            class="ml-auto min-w-0 text-[11px] font-normal text-text-secondary hover:text-primary"
            @click.stop
          >
            <ImageLink
              :image="row.container.image"
              :href="imageRegistryUrl(row.container.image)"
            />
          </span>
        </h3>

        <!-- Wrapped, the same way a conflict and a finding body are, so the
             panel has one way of saying "only while this is open". -->
        <template v-if="isOpenSection(row.container.id)">
        <div
          v-for="finding in row.findings"
          :key="finding.type"
          class="mt-1 py-2.5 px-2 border-b border-border last:border-b-0"
        >
          <!-- One line per finding until it is asked for. The prose under a
               finding runs to three paragraphs, and a container with two of
               them filled the panel with text nobody had asked to read. -->
          <div
            class="flex items-center gap-2 cursor-pointer select-none"
            @click="toggleFinding(row.container.id, finding.type)"
          >
            <ChevronIcon :expanded="isOpenFinding(row.container.id, finding.type)" />
            <span
              class="shrink-0 px-1.5 py-0.5 text-[10px] font-semibold rounded"
              :class="finding.severity === 'critical' ? 'bg-error/15 text-error' : 'bg-warning/20 text-warning'"
            >{{ finding.severity === 'critical' ? 'Critical' : 'Warning' }}</span>
            <p class="flex-1 text-sm font-semibold text-text min-w-0">{{ finding.title }}</p>
            <button
              type="button"
              class="nav-btn shrink-0"
              :title="showDismissed ? 'Show this finding again' : 'Accept this setting and hide the finding'"
              @click.stop="toggle(row.container.name, finding.type)"
            >{{ showDismissed ? 'Restore' : 'Dismiss' }}</button>
          </div>

          <template v-if="isOpenFinding(row.container.id, finding.type)">
          <p class="mt-3 text-sm text-text-secondary">{{ finding.why }}</p>
          <!-- The fix is a set of steps to take in another screen, and it read
               as one more paragraph about the risk. The label says which one it
               is, in the same type the table headers use. -->
          <p class="mt-4 mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            How to change it
          </p>
          <p class="text-sm text-text">{{ finding.fix }}</p>
          <!-- Detected on the left, recommended on the right. Both columns stay
               in the plain text token: DESIGN.md §1 keeps error and success for
               state, and a diff is not a state. -->
          <div v-if="finding.detail?.length" class="mt-4 text-xs">
            <!-- A finding with nothing to put in either column is reporting, not
                 advising, so it renders as notes and the header would be a lie. -->
            <div
              v-if="hasColumns(finding)"
              class="grid grid-cols-2 gap-x-3 pb-0.5 border-b border-border text-[10px] font-semibold uppercase tracking-wide text-text-secondary"
            >
              <span>Detected</span>
              <span>Consider</span>
            </div>
            <div
              v-for="(item, i) in finding.detail"
              :key="i"
              class="py-1 border-b border-border/40 last:border-b-0"
            >
              <div v-if="item.remove || item.add" class="grid grid-cols-2 gap-x-3">
                <span class="font-mono break-all text-text">
                  {{ item.remove }}
                  <!-- Each note names its own cell, so nothing here decides
                       which side it belongs on. -->
                  <InfoIcon v-if="item.removeNote" :text="item.removeNote" />
                </span>
                <!-- A row with a setting and no replacement is asking for the
                     setting to go, so the column says so. A row with only an
                     addition, such as a suggested port mapping, leaves the left
                     cell empty rather than filling it with a word. -->
                <span
                  class="break-all"
                  :class="item.add ? 'font-mono text-text' : 'text-muted'"
                >{{ item.add || (item.remove ? 'removal' : '') }}
                  <InfoIcon v-if="item.addNote" :text="item.addNote" />
                </span>
              </div>
              <!-- A row with no cells is a summary line, such as "And 3 more
                   exposed ports", and has nothing to hang an icon on. -->
              <p v-else-if="item.note" class="text-text-secondary">{{ item.note }}</p>
            </div>
          </div>
          <a
            :href="finding.docs"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-3 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-primary"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></svg>
            {{ docsLabel(finding.docs) }}
          </a>
          </template>
        </div>
        </template>
      </div>

      <p v-if="showDismissed && rows.length > 0" class="mt-4 text-xs text-text-secondary">
        A suggested port means no other container is using it. Ports held by
        Unraid itself, such as the webgui or SMB, are not visible here.
      </p>
    </div>

    <div class="flex items-center gap-2 px-6 py-3 border-t border-border">
      <label class="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
        <input v-model="showDismissed" type="checkbox" />
        Show dismissed
      </label>
      <span class="flex-1"></span>
      <button type="button" class="nav-btn" @click="$emit('close')">Close</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
/**
 * Security advisor panel. One instance, owned by App.vue: with `container` set
 * it shows one container, with `container` null it shows every running
 * container that has a finding.
 */
import { computed, ref, watch, type Ref } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useSecurityStore } from '@/stores/security';
import type { Container } from '@/stores/docker';
import { FALLBACK_CONTAINER_ICON } from '@/utils/containerDisplay';
import { imageRegistryUrl } from '@/utils/imageRegistry';
import {
  conflictReason,
  describeWriter,
  type FindingType,
  type FolderConflict,
  type SecurityFinding,
  type Severity,
} from '@/utils/securityFindings';
import { useDockerStore } from '@/stores/docker';
import ImageLink from '@/components/common/ImageLink.vue';
import ChevronIcon from '@/components/common/ChevronIcon.vue';
import InfoIcon from '@/components/common/InfoIcon.vue';

/**
 * Name the site the link goes to. Not every finding points at Docker: PUID and
 * PGID are a linuxserver.io convention and documented there, so a fixed label
 * would have been false.
 */
const DOCS_LABELS: Record<string, string> = {
  'docs.docker.com': 'Docker documentation',
  'docs.linuxserver.io': 'linuxserver.io documentation',
};

/** True when any row of this finding names a setting or a replacement. */
function hasColumns(finding: SecurityFinding): boolean {
  return (finding.detail ?? []).some((d) => d.remove || d.add);
}

function docsLabel(url: string): string {
  try {
    return DOCS_LABELS[new URL(url).hostname] ?? 'Documentation';
  } catch {
    return 'Documentation';
  }
}

interface Row {
  container: Container;
  findings: SecurityFinding[];
  /** The worst severity the row holds, for the badge while it is collapsed. */
  worst: Severity;
}

const props = defineProps<{
  isOpen: boolean;
  container: Container | null;
}>();

defineEmits<{ close: [] }>();

const securityStore = useSecurityStore();
const dockerStore = useDockerStore();
const showDismissed = ref(false);

/**
 * Folder clashes, shown only in the overview and only alongside open findings.
 * Opened on one container, the panel keeps that container's own rows instead:
 * a single container's list was never the part that was hard to read.
 */
const folderRows = computed(() => {
  if (props.container || showDismissed.value) return [];
  // Gone once every container on the row has accepted it. Dismissals are keyed
  // per container, so one row can only disappear when all of its sides agree.
  return securityStore.conflicts.filter((c) =>
    c.writers.some((w) => !securityStore.isDismissed(w.container, 'shared-mount-group')),
  );
});

/** Accept a folder clash on behalf of every container standing on it. */
function dismissConflict(conflict: FolderConflict) {
  for (const writer of conflict.writers) {
    if (!securityStore.isDismissed(writer.container, 'shared-mount-group')) {
      securityStore.dismiss(writer.container, 'shared-mount-group');
    }
  }
}

const iconFor = (name: string) =>
  dockerStore.containersByName.get(name)?.icon || FALLBACK_CONTAINER_ICON;

/**
 * Open or shut one key. The panel collapses on three levels, and writing the
 * same four lines once per level is three places to keep in step if opening
 * ever has to do more, such as shutting the sibling rows.
 *
 * Vue tracks `has`, `add`, and `delete` on a reactive Set, so mutating in place
 * re-renders without replacing the Set.
 */
function toggleIn(set: Ref<Set<string>>, key: string) {
  if (set.value.has(key)) set.value.delete(key);
  else set.value.add(key);
}

/**
 * Which container sections are open, by container id.
 *
 * The overview starts with every section shut, because the panel's job there
 * is to say which containers are involved: eleven findings printed in full was
 * what made it unreadable. Opened on one container, that container starts open,
 * since its own list is the only reason the panel is up.
 */
const openSections = ref<Set<string>>(new Set());

const isOpenSection = (id: string) => openSections.value.has(id);

const toggleSection = (id: string) => toggleIn(openSections, id);

/**
 * Which findings are open, keyed by container id and finding type. Separate
 * from `openSections` so opening a container does not print everything it
 * holds: the container answers "which container", the finding answers "what",
 * and only the prose under it answers "why", which is the part that is long.
 */
const openFindings = ref<Set<string>>(new Set());

const findingKey = (id: string, type: FindingType) => `${id}:${type}`;

const isOpenFinding = (id: string, type: FindingType) =>
  openFindings.value.has(findingKey(id, type));

const toggleFinding = (id: string, type: FindingType) =>
  toggleIn(openFindings, findingKey(id, type));

/** Which folder conflicts are open, by path. Shut, like everything else. */
const openConflicts = ref<Set<string>>(new Set());

const isOpenConflict = (path: string) => openConflicts.value.has(path);

const toggleConflict = (path: string) => toggleIn(openConflicts, path);

// Reopening on another container should not inherit the last toggle state.
watch(
  () => props.isOpen,
  (open) => {
    if (!open) {
      showDismissed.value = false;
      return;
    }
    resetOpen();
  },
);

// Switching sides of the toggle replaces the list, so anything open belongs to
// rows that are no longer on screen.
watch(showDismissed, resetOpen);

function resetOpen() {
  openSections.value = new Set(props.container ? [props.container.id] : []);
  openFindings.value = new Set();
  openConflicts.value = new Set();
}

const heading = computed(() =>
  props.container
    ? `Security findings for ${props.container.name}`
    : 'Security findings — running containers',
);

const emptyText = computed(() =>
  showDismissed.value
    ? 'Nothing is dismissed.'
    : props.container
      ? 'This container has no open findings.'
      : 'No running container has an open finding.',
);

/**
 * Open findings, or dismissed ones when the toggle is on. Never both: a list
 * that mixes live warnings with accepted ones reads as noise.
 */
const rows = computed<Row[]>(() => {
  const pick = (c: Container) => {
    const found = showDismissed.value
      ? securityStore.dismissedFindings(c)
      : securityStore.findings(c);
    // In the overview the folder section above already says this, once, from
    // the folder's side. Repeating it per container is the noise it replaced.
    return folderRows.value.length > 0
      ? found.filter((f) => f.type !== 'shared-mount-group')
      : found;
  };

  const source = props.container
    ? [props.container]
    : showDismissed.value
      ? securityStore.runningContainers
      : securityStore.flagged.map((f) => f.container);

  return source
    .map((container) => {
      const findings = pick(container);
      // Settled here rather than in the template. The badge shows on every
      // collapsed row, and a template call would rescan every row's findings
      // each time anything anywhere in the panel is opened.
      const worst: Severity = findings.some((f) => f.severity === 'critical')
        ? 'critical'
        : 'warning';
      return { container, findings, worst };
    })
    .filter((row) => row.findings.length > 0);
});

// Every row in the list is on the same side of the toggle, so the button's
// direction comes from `showDismissed` rather than from a flag copied per row.
function toggle(containerName: string, type: FindingType) {
  if (showDismissed.value) {
    securityStore.restore(containerName, type);
  } else {
    securityStore.dismiss(containerName, type);
  }
}
</script>
