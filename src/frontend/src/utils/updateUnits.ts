import type { Container } from '@/stores/docker';
import type { ImageUpdateStatus } from '@/stores/updates';

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

/**
 * The repo's releases index, for images that advertise a source but have no
 * cached release to link to. Shared with ContainerCard so both surfaces build
 * the same URL.
 */
export function releaseIndexUrl(status: ImageUpdateStatus | undefined): string | null {
  return status?.source_url ? `${status.source_url}/releases` : null;
}

/** One cached release a unit will actually pull in. */
export interface UnitRelease {
  /** Short repo name for multi-release labels, e.g. "grafana". */
  repoName: string;
  tag: string;
  summary: string;
  /** Where to read the notes in full — the release's own page. */
  url: string | null;
}

/**
 * The distinct releases a unit will pull, deduped by source repo.
 *
 * Only containers actually flagged for an update count. That filter is
 * load-bearing: `buildUpdateUnits` lists *every* member of a compose project,
 * not just the outdated ones, so without it a ten-service stack would
 * advertise release notes for the eight services that aren't changing.
 */
export function unitReleases(
  unit: UpdateUnit,
  updates: Record<string, ImageUpdateStatus>,
): UnitRelease[] {
  const seen = new Set<string>();
  const releases: UnitRelease[] = [];

  for (const container of unit.containers) {
    const status = updates[container.image];
    if (!status?.update_available || !status.release) continue;

    const key = status.source_repo ?? status.release.url ?? container.image;
    if (seen.has(key)) continue;
    seen.add(key);

    releases.push({
      repoName: status.source_repo?.split('/').pop() ?? container.image,
      tag: status.release.tag ?? status.release.name ?? '',
      summary: status.release.summary ?? '',
      // Prefer the exact tag's page; fall back to the repo's releases index.
      url: status.release.url ?? releaseIndexUrl(status),
    });
  }

  return releases;
}

/** How many releases get named before the summary collapses into "+N more". */
const MAX_NAMED_RELEASES = 3;

/**
 * One-line release-notes sublabel for a unit's row, or null when nothing is
 * cached — in which case the row renders exactly as it did before notes
 * existed. That null is the degraded path for offline servers, images with no
 * source label, and non-GitHub sources.
 *
 * Multiple releases show tags only: three different bodies do not fit on one
 * row, and saying "three things changed" beats pretending one of them is the
 * whole story.
 */
export function unitReleaseSummary(
  unit: UpdateUnit,
  updates: Record<string, ImageUpdateStatus>,
): string | null {
  const releases = unitReleases(unit, updates);
  if (releases.length === 0) return null;

  if (releases.length === 1) {
    const { tag, summary } = releases[0];
    if (tag && summary) return `${tag} — ${summary}`;
    return tag || summary || null;
  }

  const named = releases
    .slice(0, MAX_NAMED_RELEASES)
    .map((r) => (r.tag ? `${r.repoName} ${r.tag}` : r.repoName));
  const remaining = releases.length - named.length;
  if (remaining > 0) named.push(`+${remaining} more`);

  return named.join(' · ');
}

/**
 * Where to read a unit's release notes in full, or null when there is no one
 * page that would answer the question.
 *
 * Only single-release units get a link: a stack pulling three images has three
 * sets of notes, and picking one of them to link would misrepresent the other
 * two. Those rows keep the tag list and no link.
 */
export function unitReleaseUrl(
  unit: UpdateUnit,
  updates: Record<string, ImageUpdateStatus>,
): string | null {
  const releases = unitReleases(unit, updates);
  return releases.length === 1 ? releases[0].url : null;
}
