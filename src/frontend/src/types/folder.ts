/**
 * Folder type definitions
 */

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
