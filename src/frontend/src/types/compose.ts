/**
 * Compose stack type definitions
 */

export interface ComposeStack {
  project_name: string;
  working_dir: string | null;
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

export interface ComposeImportResult {
  success: boolean;
  stacks_imported: number;
  stacks_skipped: number;
  errors: string[];
}
