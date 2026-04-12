export type ScheduleAction = 'start' | 'stop' | 'pause' | 'restart' | 'backup';
export type TargetType = 'container' | 'stack';
export type RunStatus = 'success' | 'error' | 'skipped';

export interface BackupServiceConfig {
  service: string;
  patterns: string[];
}

export interface BackupConfig {
  paths: string[] | BackupServiceConfig[];
  destination?: string | null;
  retention_count?: number | null;
}

export interface Schedule {
  id: number;
  name: string;
  target_type: TargetType;
  target_id: string;
  action: ScheduleAction;
  cron_expression: string;
  enabled: boolean;
  backup_config: BackupConfig | null;
  last_run_at: number | null;
  last_run_status: RunStatus | null;
  last_run_message: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ScheduleHistoryEntry {
  id: number;
  schedule_id: number;
  started_at: number;
  finished_at: number | null;
  status: 'running' | RunStatus;
  message: string | null;
  backup_file: string | null;
  backup_size: number | null;
}

export interface BackupEntry {
  path: string;
  filename: string;
  size: number;
  created_at: number;
}

export type CronPreset = 'every_hour' | 'daily_3am' | 'daily_custom' | 'weekly_custom' | 'custom';

export const CRON_PRESETS: Record<CronPreset, { label: string; expression: string | null }> = {
  every_hour: { label: 'Every hour', expression: '0 * * * *' },
  daily_3am: { label: 'Daily at 3:00 AM', expression: '0 3 * * *' },
  daily_custom: { label: 'Daily at...', expression: null },
  weekly_custom: { label: 'Weekly on...', expression: null },
  custom: { label: 'Custom cron', expression: null },
};
