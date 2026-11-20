/**
 * Compose stack type definitions
 */

export interface ComposeStack {
  project_name: string;
  working_dir: string | null;
  /** True when the files sit in the plugin's own stack folder, so Remove Stack may delete them. */
  own_files?: boolean;
  /** `compose_manager` when the stack runs from the Compose Manager projects folder (by path), else null. */
  source?: 'compose_manager' | null;
  compose_file: string | null;
  env_file: string | null;
  autostart: boolean;
  autostart_force_recreate: boolean;
  description: string | null;
  imported_from: string | null;
  services_running: number;
  services_total: number;
  service_names?: string[];
}

export interface ComposeStatus {
  compose_available: boolean;
  compose_version: string | null;
  compose_plugin_installed: boolean;
  management_enabled: boolean;
  compose_plugin_data_exists?: boolean;
}

export interface ComposeFileVersion {
  id: number;
  file_type: 'compose' | 'env';
  file_path: string;
  content_hash: string;
  created_at: number;
}

export interface ComposeFileVersionDetail extends ComposeFileVersion {
  content: string;
}

/** What `compose.php?action=remove` answers with once the stack is gone. */
export interface ComposeRemoveResult {
  success: boolean;
  schedules_removed: number;
  /** What became of the stack folder: deleted, kept as a plain folder, or none. */
  folder: 'deleted' | 'kept' | 'none';
  files_removed: string[];
  directory_removed: boolean;
  /** Why files were left in place, when they were. */
  files_note: string | null;
}

export interface ComposeImportResult {
  success: boolean;
  stacks_imported: number;
  stacks_skipped: number;
  errors: string[];
}

/**
 * One problem `docker compose config` reported, positioned in the file.
 * The compose editor turns these into CodeMirror diagnostics.
 */
export interface ComposeValidationError {
  line: number;
  column?: number;
  message: string;
}
