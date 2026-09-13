/**
 * Shared sort-mode logic for folders and folder contents.
 *
 * `manual` mode sorts by the caller-supplied `position` (drag & drop order,
 * persisted server-side). Every other mode is a pure, non-persistent sort
 * computed at render time — toggling it never rewrites stored positions.
 */
import type { SortMode } from '@/types/folder';

const STATE_ORDER: Record<string, number> = {
  running: 0,
  restarting: 1,
  paused: 1,
  created: 2,
  exited: 3,
  dead: 3,
};

/** Rank of a state, with unknown or missing states after every known one. */
function stateRank(state: string | undefined): number {
  return STATE_ORDER[state ?? ''] ?? 4;
}

/**
 * The highest-ranked state in a group (running before paused before exited),
 * so a folder sorts under "Status" by its most active container.
 */
export function bestState(states: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const state of states) {
    if (state === undefined) continue;
    if (best === undefined || stateRank(state) < stateRank(best)) best = state;
  }
  return best;
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export interface SortableFields {
  /** Stored manual order. */
  position: number;
  /** Display name used for alphabetical sorting. */
  name: string;
  /** Docker `state` string (e.g. 'running', 'exited'), if applicable. */
  state?: string;
  /** Unix timestamp (seconds) the item was created. */
  created?: number;
}

/**
 * The mode a folder's contents actually render in. A folder left on `manual`
 * follows the toolbar (global) sort; any other folder mode is an explicit
 * override. So picking "Status" in the toolbar also orders every folder that
 * the user did not set to its own mode.
 */
export function effectiveSortMode(folderMode: SortMode, globalMode: SortMode): SortMode {
  return folderMode !== 'manual' ? folderMode : globalMode;
}

/**
 * Sorts a copy of `items` according to `mode`. `getFields` extracts the
 * comparable fields from each item so this works for both Folder and
 * ContainerAssociation-resolved-to-Container inputs without coupling
 * this module to either type.
 */
export function sortByMode<T>(items: T[], mode: SortMode, getFields: (item: T) => SortableFields): T[] {
  // Extract fields once per item, not once per comparison: getFields can walk
  // a folder's members, and sort calls the comparator O(n log n) times.
  const decorated = items.map((item) => ({ item, f: getFields(item) }));
  let compare: (a: SortableFields, b: SortableFields) => number;

  switch (mode) {
    case 'name-asc':
      compare = (a, b) => nameCollator.compare(a.name, b.name);
      break;
    case 'name-desc':
      compare = (a, b) => nameCollator.compare(b.name, a.name);
      break;
    case 'status':
      compare = (a, b) => stateRank(a.state) - stateRank(b.state) || nameCollator.compare(a.name, b.name);
      break;
    case 'created-asc':
      compare = (a, b) => (a.created ?? 0) - (b.created ?? 0);
      break;
    case 'created-desc':
      compare = (a, b) => (b.created ?? 0) - (a.created ?? 0);
      break;
    case 'manual':
    default:
      compare = (a, b) => a.position - b.position;
  }

  return decorated.sort((a, b) => compare(a.f, b.f)).map((d) => d.item);
}
