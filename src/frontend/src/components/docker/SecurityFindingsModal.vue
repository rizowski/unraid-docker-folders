<template>
  <BaseModal :is-open="isOpen" max-width="640px" @close="$emit('close')">
    <div class="px-6 py-4 border-b border-border">
      <h2 class="text-base font-semibold text-text">{{ heading }}</h2>
      <p class="text-sm text-text-secondary mt-1">
        Settings that give a container more of the server than it usually needs,
        and folders two containers write as users that cannot read each other's
        files. Nothing here is changed for you — each finding says what to change
        in Unraid's own Docker edit form.
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
          <div class="flex items-start gap-2">
            <p class="flex-1 min-w-0 font-mono text-xs break-all text-text">{{ conflict.path }}</p>
            <button
              type="button"
              class="nav-btn shrink-0"
              title="Accept this folder and hide it, for every container on it"
              @click="dismissConflict(conflict)"
            >Dismiss</button>
          </div>

          <div
            v-for="writer in conflict.writers"
            :key="writer.container"
            class="flex items-center gap-2 mt-1 text-xs"
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

          <p class="mt-1 text-xs text-text-secondary">{{ conflictReason(conflict) }}</p>
        </div>
      </section>

      <div v-for="row in rows" :key="row.container.id" class="mb-5 last:mb-0">
        <h3 class="flex items-center gap-2 text-sm font-semibold text-text border-b border-border pb-1 mb-2">
          <!-- A plain img, not ContainerIcon: the halo means running state and
               every row here is running, so it would be decoration. -->
          <img
            :src="row.container.icon || FALLBACK_CONTAINER_ICON"
            :alt="row.container.name"
            class="shrink-0 w-5 h-5 object-contain"
          />
          {{ row.container.name }}
          <!-- The image page documents the ports and variables this panel keeps
               telling people to go and check, so it belongs on the container,
               not on one finding. -->
          <span class="ml-auto min-w-0 text-[11px] font-normal text-text-secondary hover:text-primary">
            <ImageLink
              :image="row.container.image"
              :href="imageRegistryUrl(row.container.image)"
            />
          </span>
        </h3>

        <div
          v-for="finding in row.findings"
          :key="finding.type"
          class="py-2 border-b border-border last:border-b-0"
        >
          <div class="flex items-start gap-2">
            <span
              class="shrink-0 mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold rounded"
              :class="finding.severity === 'critical' ? 'bg-error/15 text-error' : 'bg-warning/20 text-warning'"
            >{{ finding.severity === 'critical' ? 'Critical' : 'Warning' }}</span>
            <p class="flex-1 text-sm font-semibold text-text min-w-0">{{ finding.title }}</p>
            <button
              type="button"
              class="nav-btn shrink-0"
              :title="showDismissed ? 'Show this finding again' : 'Accept this setting and hide the finding'"
              @click="toggle(row.container.name, finding.type)"
            >{{ showDismissed ? 'Restore' : 'Dismiss' }}</button>
          </div>

          <p class="mt-1 text-sm text-text-secondary">{{ finding.why }}</p>
          <p class="mt-1 text-sm text-text">{{ finding.fix }}</p>
          <!-- Detected on the left, recommended on the right. Both columns stay
               in the plain text token: DESIGN.md §1 keeps error and success for
               state, and a diff is not a state. -->
          <div v-if="finding.detail?.length" class="mt-2 text-xs">
            <div class="grid grid-cols-2 gap-x-3 pb-0.5 border-b border-border text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <span>Detected</span>
              <span>Consider</span>
            </div>
            <div
              v-for="(item, i) in finding.detail"
              :key="i"
              class="py-1 border-b border-border/40 last:border-b-0"
            >
              <div class="grid grid-cols-2 gap-x-3">
                <span class="font-mono break-all text-text">{{ item.remove }}</span>
                <!-- A row with a setting and no replacement is asking for the
                     setting to go, so the column says so. A row with only an
                     addition, such as a suggested port mapping, leaves the left
                     cell empty rather than filling it with a word. -->
                <span
                  class="break-all"
                  :class="item.add ? 'font-mono text-text' : 'text-muted'"
                >{{ item.add || (item.remove ? 'removal' : '') }}</span>
              </div>
              <p v-if="item.note" class="mt-0.5 text-text-secondary">{{ item.note }}</p>
            </div>
          </div>
          <a
            :href="finding.docs"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1 inline-flex items-center gap-1 text-xs text-text-secondary hover:text-primary"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></svg>
            {{ docsLabel(finding.docs) }}
          </a>
        </div>
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
import { computed, ref, watch } from 'vue';
import BaseModal from '@/components/BaseModal.vue';
import { useSecurityStore } from '@/stores/security';
import type { Container } from '@/stores/docker';
import { FALLBACK_CONTAINER_ICON } from '@/utils/containerDisplay';
import { imageRegistryUrl } from '@/utils/imageRegistry';
import { conflictReason, describeWriter, type FolderConflict } from '@/utils/securityFindings';
import { useDockerStore } from '@/stores/docker';
import ImageLink from '@/components/common/ImageLink.vue';

/**
 * Name the site the link goes to. Not every finding points at Docker: PUID and
 * PGID are a linuxserver.io convention and documented there, so a fixed label
 * would have been false.
 */
const DOCS_LABELS: Record<string, string> = {
  'docs.docker.com': 'Docker documentation',
  'docs.linuxserver.io': 'linuxserver.io documentation',
};

function docsLabel(url: string): string {
  try {
    return DOCS_LABELS[new URL(url).hostname] ?? 'Documentation';
  } catch {
    return 'Documentation';
  }
}
import type { FindingType, SecurityFinding } from '@/utils/securityFindings';

interface Row {
  container: Container;
  findings: SecurityFinding[];
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

// Reopening on another container should not inherit the last toggle state.
watch(
  () => props.isOpen,
  (open) => {
    if (!open) showDismissed.value = false;
  },
);

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
    .map((container) => ({ container, findings: pick(container) }))
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
