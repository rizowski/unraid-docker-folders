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
 * Sorts a copy of `items` according to `mode`. `getFields` extracts the
 * comparable fields from each item so this works for both Folder and
 * ContainerAssociation-resolved-to-Container inputs without coupling
 * this module to either type.
 */
export function sortByMode<T>(items: T[], mode: SortMode, getFields: (item: T) => SortableFields): T[] {
  const list = [...items];

  switch (mode) {
    case 'name-asc':
      return list.sort((a, b) => getFields(a).name.localeCompare(getFields(b).name, undefined, { sensitivity: 'base', numeric: true }));

    case 'name-desc':
      return list.sort((a, b) => getFields(b).name.localeCompare(getFields(a).name, undefined, { sensitivity: 'base', numeric: true }));

    case 'status':
      return list.sort((a, b) => {
        const fa = getFields(a);
        const fb = getFields(b);
        const order = (STATE_ORDER[fa.state ?? ''] ?? 4) - (STATE_ORDER[fb.state ?? ''] ?? 4);
        return order !== 0 ? order : fa.name.localeCompare(fb.name, undefined, { sensitivity: 'base', numeric: true });
      });

    case 'created-asc':
      return list.sort((a, b) => (getFields(a).created ?? 0) - (getFields(b).created ?? 0));

    case 'created-desc':
      return list.sort((a, b) => (getFields(b).created ?? 0) - (getFields(a).created ?? 0));

    case 'manual':
    default:
      return list.sort((a, b) => getFields(a).position - getFields(b).position);
  }
}
