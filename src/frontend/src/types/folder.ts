/**
 * Folder type definitions
 */

/**
 * How folders and folder contents are ordered.
 * 'manual' preserves the stored `position` (drag & drop order).
 * All other modes are computed at render time and don't touch `position`.
 */
export type SortMode = 'manual' | 'name-asc' | 'name-desc' | 'status' | 'created-asc' | 'created-desc';

/**
 * `icon` is stroke path data in KebabMenu's format: `<path d>` segments joined
 * by `|`, drawn in a 24x24 viewBox.
 */
export const SORT_MODE_OPTIONS: Array<{ value: SortMode; label: string; icon: string }> = [
  // Six-dot grip, matching common/DragHandle.vue (dots as zero-length round-capped paths).
  { value: 'manual', label: 'Manual (drag & drop)', icon: 'M9 5h.01|M9 12h.01|M9 19h.01|M15 5h.01|M15 12h.01|M15 19h.01' },
  { value: 'name-asc', label: 'Name (A → Z)', icon: 'M3 16l4 4 4-4|M7 20V4|M20 8h-5|M15 10V6.5a2.5 2.5 0 0 1 5 0V10|M15 14h5l-5 6h5' },
  { value: 'name-desc', label: 'Name (Z → A)', icon: 'M3 16l4 4 4-4|M7 4v16|M15 4h5l-5 6h5|M15 20v-3.5a2.5 2.5 0 0 1 5 0V20|M20 18h-5' },
  { value: 'status', label: 'Status (running first)', icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
  { value: 'created-desc', label: 'Newest first', icon: 'M14 18l4-4 4 4|M16 2v4|M18 22v-8|M21 12.598V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8.5|M3 10h18|M8 2v4' },
  { value: 'created-asc', label: 'Oldest first', icon: 'M14 18l4 4 4-4|M16 2v4|M18 14v8|M21 11.354V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7.343|M3 10h18|M8 2v4' },
];

export interface ContainerAssociation {
  id: number;
  container_id: string;
  container_name: string;
  folder_id: number;
  position: number;
}

/**
 * A container the user wants in a folder. Membership is keyed on `name`
 * (container ids change when a container is recreated); `id` is carried only as
 * the payload the add_container endpoint requires.
 */
export interface FolderContainerSelection {
  id: string;
  name: string;
}

export interface Folder {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  collapsed: boolean;
  compose_project: string | null;
  /** How this folder's own containers are ordered. Defaults to 'manual'. */
  sort_mode: SortMode;
  created_at: number;
  updated_at: number;
  containers: ContainerAssociation[];
}

export interface FolderCreateData {
  name: string;
  icon?: string | null;
  color?: string | null;
}

export interface FolderUpdateData {
  name?: string;
  icon?: string | null;
  color?: string | null;
  position?: number;
  collapsed?: boolean;
  sort_mode?: SortMode;
}

export interface FolderExportConfig {
  version: string;
  exported_at: string;
  folders: Array<{
    name: string;
    icon: string | null;
    color: string | null;
    position: number;
    containers: Array<{
      id: string;
      name: string;
    }>;
  }>;
}

export interface FolderImportResult {
  success: boolean;
  folders_created: number;
  containers_assigned: number;
  errors: string[];
}
