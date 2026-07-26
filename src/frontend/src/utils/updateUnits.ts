import type { Container } from '@/stores/docker';

/**
 * An update unit is one update operation plus the exact set of containers it
 * will touch. Units are disjoint by container: a container belongs to exactly
 * one unit, so concurrent units never write to the same container.
 *
 * That disjointness is why compose containers are claimed first. `pull.php`
 * recreates by image across the whole daemon, so without an explicit owner a
 * standalone container's image pull could recreate a compose-managed container
 * while that stack's `compose up` was mid-flight.
 */
export type UpdateUnit =
  | {
      kind: 'compose';
      id: string;
      /** Compose project name, used as the label and the API's `project` param. */
      project: string;
      containers: Container[];
    }
  | {
      kind: 'image';
      id: string;
      image: string;
      containers: Container[];
    };

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** The compose project a container belongs to, or null if it isn't compose-managed. */
export function composeProjectOf(container: Container): string | null {
  const project = container.labels?.[COMPOSE_PROJECT_LABEL];
  return project ? project : null;
}

/** Display label for a unit — the compose project name or the image reference. */
export function unitLabel(unit: UpdateUnit): string {
  return unit.kind === 'compose' ? unit.project : unit.image;
}

/**
 * Group the containers that have updates into disjoint update units.
 *
 * @param withUpdates   Containers flagged as having an update available.
 * @param allContainers The full container list, used to find siblings that
 *                      share an image unit's image. Those siblings get
 *                      recreated by the same pull, so they must be listed
 *                      even though they weren't flagged individually.
 * @param composeEnabled Whether compose management is available. When false,
 *                      compose containers are not claimed and fall through to
 *                      image units, matching the pre-compose behavior.
 */
export function buildUpdateUnits(
  withUpdates: Container[],
  allContainers: Container[],
  composeEnabled: boolean,
): UpdateUnit[] {
  const units: UpdateUnit[] = [];
  const claimed = new Set<string>();

  // Compose units first — they own their containers.
  if (composeEnabled) {
    const byProject = new Map<string, Container[]>();
    for (const container of withUpdates) {
      const project = composeProjectOf(container);
      if (!project) continue;
      const members = byProject.get(project);
      if (members) members.push(container);
      else byProject.set(project, [container]);
    }

    for (const [project, flagged] of byProject) {
      // `docker compose up` acts on the whole stack, so list every member of
      // the project, not just the ones flagged as outdated.
      const members = allContainers.filter((c) => composeProjectOf(c) === project);
      const containers = members.length > 0 ? members : flagged;
      for (const c of containers) claimed.add(c.id);
      units.push({ kind: 'compose', id: `compose:${project}`, project, containers });
    }
  }

  // Remaining containers group by image.
  const byImage = new Map<string, Container[]>();
  for (const container of withUpdates) {
    if (claimed.has(container.id)) continue;
    const members = byImage.get(container.image);
    if (members) members.push(container);
    else byImage.set(container.image, [container]);
  }

  for (const [image, flagged] of byImage) {
    // Siblings on the same image are recreated by the same pull. Include them
    // so the confirm list matches what actually happens — but never steal a
    // container already owned by a compose unit.
    const siblings = allContainers.filter(
      (c) => c.image === image && !claimed.has(c.id),
    );
    const containers = siblings.length > 0 ? siblings : flagged;
    for (const c of containers) claimed.add(c.id);
    units.push({ kind: 'image', id: `image:${image}`, image, containers });
  }

  return units;
}
