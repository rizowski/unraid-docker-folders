/**
 * Folder type definitions
 */

/**
 * How folders and folder contents are ordered.
 * 'manual' preserves the stored `position` (drag & drop order).
 * All other modes are computed at render time and don't touch `position`.
 */
export type SortMode = 'manual' | 'name-asc' | 'name-desc' | 'status' | 'created-asc' | 'created-desc';

export const SORT_MODE_OPTIONS: Array<{ value: SortMode; label: string }> = [
  { value: 'manual', label: 'Manual (drag & drop)' },
  { value: 'name-asc', label: 'Name (A → Z)' },
  { value: 'name-desc', label: 'Name (Z → A)' },
  { value: 'status', label: 'Status (running first)' },
  { value: 'created-desc', label: 'Newest first' },
  { value: 'created-asc', label: 'Oldest first' },
];

export interface ContainerAssociation {
  id: number;
  container_id: string;
  container_name: string;
  folder_id: number;
  position: number;
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
