/**
 * Security Store - findings per container, and the dismissals that hide them.
 *
 * The rules live in utils/securityFindings.ts and run over data the container
 * list already carries, so there is nothing to fetch. Only the dismissals are
 * server-side: they arrive with the container list and are written back through
 * containers.php, keyed by container name so they survive a recreate.
 */

import { defineStore } from 'pinia';
import { computed } from 'vue';
import { useBackend } from '@/backends';
import type { FindingAction } from '@/backends/types';
import { useDockerStore, type Container } from '@/stores/docker';
import { useSettingsStore } from '@/stores/settings';
import {
  findingsFor,
  folderConflicts,
  mountWritersFor,
  parseExposedPort,
  severityRank,
  type FindingType,
  type FolderConflict,
  type MountWriter,
  type PortOwners,
  type SecurityFinding,
} from '@/utils/securityFindings';

export interface ContainerFindings {
  container: Container;
  findings: SecurityFinding[];
}

const dismissalKey = (containerName: string, type: FindingType | string) =>
  `${containerName}:${type}`;

export const useSecurityStore = defineStore('security', () => {
  const dockerStore = useDockerStore();
  const settingsStore = useSettingsStore();

  const dismissed = computed<Set<string>>(() => {
    const set = new Set<string>();
    for (const d of dockerStore.securityDismissals) {
      set.add(dismissalKey(d.container_name, d.finding_type));
    }
    return set;
  });

  const enabled = computed(() => settingsStore.enableSecurityAdvisor);

  /**
   * Who holds which host port, for the port the advisor suggests.
   *
   * Published bindings come from the docker store, over every container. On top
   * of that, a *running* host-network container holds each of its exposed ports
   * on the host without any binding to show for it, so suggesting one of those
   * would collide with the very class of container this check targets.
   */
  const portOwners = computed<PortOwners>(() => {
    const owners = new Map(dockerStore.boundHostPorts);
    for (const c of dockerStore.containers) {
      if (c.networkMode !== 'host' || c.state !== 'running') continue;
      for (const spec of c.exposedPorts ?? []) {
        const parsed = parseExposedPort(spec);
        if (parsed && !owners.has(parsed.port)) owners.set(parsed.port, c.name);
      }
    }
    return owners;
  });

  /**
   * The containers the advisor looks at. A stopped one is left out on purpose:
   * its settings only matter once it starts, and including them would flag old
   * containers nobody uses any more.
   */
  const runningContainers = computed<Container[]>(() =>
    dockerStore.containers.filter((c) => c.state === 'running'),
  );

  /**
   * Every writable bind mount on the box, with the user behind it.
   *
   * Built once here rather than per container, because the shared-folder check
   * has to compare each container against all the others. Running containers
   * only, matching the rest of the advisor.
   */
  const mountWriters = computed<MountWriter[]>(() =>
    runningContainers.value.flatMap(mountWritersFor),
  );

  /**
   * Folder clashes, keyed by folder rather than by container.
   *
   * The panel lists these once each. Read from a container instead, the same
   * clash appears on both sides saying the same thing mirrored, which is what
   * made the per-container view hard to scan.
   */
  const conflicts = computed<FolderConflict[]>(() => {
    if (!enabled.value) return [];
    return folderConflicts(mountWriters.value);
  });

  /**
   * Every container's findings, derived once per container list.
   *
   * The rule set is not cheap — a capability scan, a mount scan, and a linear
   * search for a free host port per exposed port — and three consumers ask for
   * the same container: the header count, the card badge, and the panel. Each
   * fetch replaces `containers` wholesale, so without this they would all
   * re-derive on every poll.
   */
  const findingsByContainer = computed<Map<string, SecurityFinding[]>>(() => {
    const byId = new Map<string, SecurityFinding[]>();
    if (!enabled.value) return byId;
    for (const c of runningContainers.value) {
      byId.set(c.id, findingsFor(c, portOwners.value, mountWriters.value));
    }
    return byId;
  });

  /**
   * Every finding for a container, dismissed ones included.
   *
   * A container that is not running has none. The gate lives here rather than
   * at each caller so the card badge and the panel cannot disagree about it.
   *
   * The map above is an optimization, not the definition: a caller holding a
   * container the store does not list, such as a card rendering a prop, still
   * gets the same answer.
   */
  function allFindings(container: Container): SecurityFinding[] {
    if (!enabled.value || container.state !== 'running') return [];
    return (
      findingsByContainer.value.get(container.id) ??
      findingsFor(container, portOwners.value, mountWriters.value)
    );
  }

  /** Findings the user has not accepted. What the badge and panel count. */
  function findings(container: Container): SecurityFinding[] {
    return allFindings(container).filter(
      (f) => !dismissed.value.has(dismissalKey(container.name, f.type)),
    );
  }

  /** Findings the user accepted, for the "show dismissed" toggle. */
  function dismissedFindings(container: Container): SecurityFinding[] {
    return allFindings(container).filter((f) =>
      dismissed.value.has(dismissalKey(container.name, f.type)),
    );
  }

  function isDismissed(containerName: string, type: FindingType): boolean {
    return dismissed.value.has(dismissalKey(containerName, type));
  }

  const flagged = computed<ContainerFindings[]>(() => {
    const rows: ContainerFindings[] = [];
    for (const container of runningContainers.value) {
      const found = findings(container);
      if (found.length > 0) rows.push({ container, findings: found });
    }
    return rows.sort((a, b) => {
      const bySeverity = severityRank(a.findings[0].severity) - severityRank(b.findings[0].severity);
      return bySeverity !== 0 ? bySeverity : a.container.name.localeCompare(b.container.name);
    });
  });

  const findingCount = computed(() =>
    flagged.value.reduce((total, row) => total + row.findings.length, 0),
  );

  const hasCritical = computed(() =>
    flagged.value.some((row) => row.findings.some((f) => f.severity === 'critical')),
  );

  async function post(action: FindingAction, name: string, type: FindingType) {
    try {
      const { ok, error: failure } = await useBackend().containers.setFindingDismissed(action, name, type);
      if (!ok) throw new Error(failure);
      return true;
    } catch (e) {
      console.error(`Error saving security dismissal:`, e);
      // Put the optimistic change back: the next container fetch would do it
      // anyway, but not for up to 30 seconds.
      await dockerStore.fetchContainers(true);
      return false;
    }
  }

  async function dismiss(containerName: string, type: FindingType): Promise<boolean> {
    if (!isDismissed(containerName, type)) {
      dockerStore.securityDismissals.push({ container_name: containerName, finding_type: type });
    }
    return post('dismiss-finding', containerName, type);
  }

  async function restore(containerName: string, type: FindingType): Promise<boolean> {
    dockerStore.securityDismissals = dockerStore.securityDismissals.filter(
      (d) => !(d.container_name === containerName && d.finding_type === type),
    );
    return post('restore-finding', containerName, type);
  }

  return {
    enabled,
    runningContainers,
    conflicts,
    flagged,
    findingCount,
    hasCritical,
    allFindings,
    findings,
    dismissedFindings,
    isDismissed,
    dismiss,
    restore,
  };
});
