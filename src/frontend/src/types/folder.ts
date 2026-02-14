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

export interface Folder {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  collapsed: boolean;
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
