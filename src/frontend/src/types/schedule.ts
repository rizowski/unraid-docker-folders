export type ScheduleAction = 'start' | 'stop' | 'pause' | 'resume' | 'restart' | 'backup' | 'update';
export type TargetType = 'container' | 'stack';
export type RunStatus = 'success' | 'error' | 'skipped';

export const SCHEDULE_ACTION_LABELS: Record<ScheduleAction, string> = {
  start: 'Start', stop: 'Stop', pause: 'Pause', resume: 'Resume', restart: 'Restart', backup: 'Backup',
  update: 'Update',
};

export interface BackupServiceConfig {
  service: string;
  patterns: string[];
}

/**
 * What happens to the container while its files are archived.
 *
 * 'none' is the old behavior and stays the default for a schedule saved before
 * this field existed. A backup in 'pause' or 'stop' mode changes container
 * state, so a late run of one is skipped rather than caught up.
 */
export type QuiesceMode = 'none' | 'pause' | 'stop';

export const QUIESCE_MODES: QuiesceMode[] = ['none', 'pause', 'stop'];

export const QUIESCE_LABELS: Record<QuiesceMode, string> = {
  none: 'Leave running',
  pause: 'Pause during backup',
  stop: 'Stop during backup',
};

export const QUIESCE_HELP: Record<QuiesceMode, string> = {
  none: 'Fastest. A database in this folder can be copied in a broken state.',
  pause: 'Recommended. The container freezes for the length of the backup.',
  stop: 'Safest. The container is down for the length of the backup.',
};

/**
 * 'files' archives mounted folders. 'postgres' runs pg_dump inside the
 * container, one dump per database. A config with no mode is 'files'.
 */
export type BackupMode = 'files' | 'postgres';

/**
 * Where a Postgres backup gets its login. 'env' reads POSTGRES_USER and
 * POSTGRES_PASSWORD from the container on every run and stores nothing.
 * 'custom' stores the user and password the form was given.
 */
export type PostgresCredentials = 'env' | 'custom';

export interface PostgresBackupConfig {
  /** The compose service that runs Postgres, for a stack schedule. */
  service?: string;
  /** Absent means 'env'. */
  credentials?: PostgresCredentials;
  /** Custom credentials only. */
  user?: string;
  /** Write only. The server never returns it. Empty on an update keeps the saved one. */
  password?: string;
  /** Response only: whether a password is saved. */
  password_set?: boolean;
  databases: string[];
}

export interface BackupConfig {
  mode?: BackupMode;
  paths: string[] | BackupServiceConfig[];
  postgres?: PostgresBackupConfig;
  destination?: string | null;
  retention_count?: number | null;
  /** Ignored in postgres mode: pg_dump never pauses or stops the container. */
  quiesce?: QuiesceMode;
}

/** What the form needs to offer Postgres mode. Never carries a password. */
export interface PostgresInfo {
  is_postgres: boolean;
  running: boolean;
  /** POSTGRES_USER, or 'postgres' when the container sets none. */
  env_user: string;
  has_env_password: boolean;
}

/** A container, or one compose service of a stack. */
export interface PostgresTarget {
  target_type: TargetType;
  target_id: string;
  service?: string;
}

export interface PostgresDatabasesRequest extends PostgresTarget {
  credentials: PostgresCredentials;
  user?: string;
  password?: string;
  /** Use this schedule's saved password when `password` is empty. */
  schedule_id?: number;
}

export interface PostgresDatabasesResult {
  success: boolean;
  databases: string[];
  message: string;
}

/** One directory offered by api/paths.php while the user types. */
export interface PathSuggestion {
  name: string;
  path: string;
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

/**
 * Health of the per-minute schedule runner, from the list endpoint.
 *
 * `last_tick` is a Unix timestamp in seconds, or null when the runner has not
 * fired since the last reboot. Schedules only run when this stays fresh.
 */
export interface ScheduleRunnerState {
  last_tick: number | null;
  /** Decided server-side, because last_tick is a server clock reading. */
  stale: boolean;
  stale_after: number;
  cron_installed: boolean;
  /**
   * True only on the response that put a missing cron entry back. The runner
   * is installed but has not fired yet, so `stale` is still true and will stay
   * true until the next minute boundary.
   */
  repaired: boolean;
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
