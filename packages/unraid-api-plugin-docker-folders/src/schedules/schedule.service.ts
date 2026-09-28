import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';

import { MODE_POSTGRES, modeOf, prepareBackupConfig } from '../backups/postgres-backup.js';
import { DatabaseService } from '../db/database.service.js';
import { EventBusService } from '../events/event-bus.service.js';
import { nowSeconds } from '../util/time.js';
import { computeNextRun, validateCronExpression } from './cron.js';
import { formatRunLateness, notifyScheduleResult } from './schedule-notifications.js';

/**
 * Schedules, ported from `ScheduleManager.php` and the validation that
 * `api/schedules.php` does before calling it.
 *
 * Rows stay snake_case here, because that is the database's shape and the
 * shape the frontend's `Schedule` interface already reads. The GraphQL layer
 * converts at its own edge.
 *
 * What this does not do is touch cron. Every PHP write ends in
 * `CronManager::ensureSchedulerCron()`, which adds or removes the once a
 * minute runner line in root's crontab. The plugin runs its own tick inside
 * the API process instead, so it has no line to maintain, and this plugin
 * never writes root's crontab.
 */

export const SCHEDULE_ACTIONS = ['start', 'stop', 'pause', 'resume', 'restart', 'backup', 'update'] as const;
export const TARGET_TYPES = ['container', 'stack'] as const;

/** A run that is this late is skipped rather than fired, unless it is safe. */
export const MISFIRE_GRACE_SECONDS = 300;

/** How many history rows each schedule keeps. */
const HISTORY_KEEP = 200;

export interface ScheduleRow {
    id: number;
    name: string;
    target_type: string;
    target_id: string;
    action: string;
    cron_expression: string;
    enabled: number;
    backup_config: string | null;
    last_run_at: number | null;
    last_run_status: string | null;
    last_run_message: string | null;
    next_run_at: number | null;
    created_at: number;
    updated_at: number;
}

export interface ScheduleHistoryRow {
    id: number;
    schedule_id: number;
    started_at: number;
    finished_at: number | null;
    status: string;
    message: string | null;
    backup_file: string | null;
    backup_size: number | null;
}

export interface ScheduleWrite {
    name?: string;
    target_type?: string;
    target_id?: string;
    action?: string;
    cron_expression?: string;
    enabled?: boolean;
    /** Already JSON. PHP accepts an object or a string and stores a string. */
    backup_config?: string | null;
}

/** What an action reports. `backup_file` and `backup_size` only for a backup. */
export interface ActionOutcome {
    success: boolean;
    message: string;
    backup_file?: string;
    backup_size?: number;
}

/**
 * The work a schedule can trigger, injected so this class needs neither
 * Docker nor tar to be tested, and so the runner cannot reach an action by
 * any route other than these three.
 */
export interface ScheduleExecutors {
    containerAction(containerName: string, action: string): Promise<ActionOutcome>;
    stackAction(projectName: string, action: string): Promise<ActionOutcome>;
    backup(schedule: ScheduleRow): Promise<ActionOutcome>;
}

export const SCHEDULE_EXECUTORS_TOKEN = 'DOCKER_FOLDERS_SCHEDULE_EXECUTORS';

export interface RunResult {
    success: boolean;
    schedule_id: number;
    status: 'success' | 'error' | 'skipped' | 'busy' | 'started';
    message: string;
    late_by?: number;
    name?: string;
    target_type?: string;
    target_id?: string;
    action?: string;
}

/** `BackupManager::quiesceModeFor`: anything unknown means leave it alone. */
export function quiesceModeFor(value: unknown): 'none' | 'pause' | 'stop' {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return mode === 'pause' || mode === 'stop' ? mode : 'none';
}

/**
 * Should an overdue run be skipped rather than fired?
 *
 * A late backup that only reads files is still worth having, so it catches
 * up. A late start, stop, pause, resume or restart is a surprise state change
 * in the middle of the working day, so it is skipped. A backup that pauses or
 * stops its container is a state change too, which is why quiesce decides it.
 */
export function shouldSkipMissedRun(action: string, lateBySeconds: number, quiesce: string): boolean {
    if (action === 'backup' && quiesceModeFor(quiesce) === 'none') return false;
    return lateBySeconds > MISFIRE_GRACE_SECONDS;
}

export function scheduleQuiesceMode(schedule: Pick<ScheduleRow, 'action' | 'backup_config'>): string {
    if (schedule.action !== 'backup' || schedule.backup_config === null) return 'none';
    try {
        const config = JSON.parse(schedule.backup_config) as { quiesce?: unknown } | null;
        // pg_dump never pauses or stops the container, so a late Postgres
        // backup catches up like quiesce 'none'.
        if (modeOf(config) === MODE_POSTGRES) return 'none';
        return quiesceModeFor(config?.quiesce);
    } catch {
        return 'none';
    }
}

/** `ScheduleManager::prepareBackupConfig`, with its errors as a 400. */
function toStoredBackupConfig(json: string, targetType: string, storedJson: string | null): string {
    try {
        return prepareBackupConfig(json, targetType, storedJson);
    } catch (error) {
        throw new BadRequestException((error as Error).message);
    }
}

@Injectable()
export class ScheduleService {
    private readonly logger = new Logger(ScheduleService.name);
    /** Schedules with a run in progress. See `execute`. */
    private readonly runningIds = new Set<number>();

    constructor(
        private readonly db: DatabaseService,
        private readonly events: EventBusService,
        @Inject(SCHEDULE_EXECUTORS_TOKEN) private readonly executors: ScheduleExecutors
    ) {}

    list(filters: { target_type?: string; target_id?: string; enabled?: boolean } = {}): ScheduleRow[] {
        // Built from a fixed set of column names; only the values are bound.
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (filters.target_type) {
            where.push('target_type = ?');
            params.push(filters.target_type);
        }
        if (filters.target_id) {
            where.push('target_id = ?');
            params.push(filters.target_id);
        }
        if (filters.enabled !== undefined) {
            where.push('enabled = ?');
            params.push(filters.enabled ? 1 : 0);
        }

        const sql =
            'SELECT * FROM schedules' +
            (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
            ' ORDER BY name ASC';

        return this.db.read((db) => db.prepare(sql).all(...params) as unknown as ScheduleRow[]);
    }

    get(id: number): ScheduleRow | null {
        return this.db.read((db) => readRow(db, id));
    }

    create(data: ScheduleWrite): number {
        // PHP's `empty()`, which also treats the string "0" as missing.
        for (const field of ['name', 'target_type', 'target_id', 'action', 'cron_expression'] as const) {
            if (!data[field] || data[field] === '0') {
                throw new BadRequestException(`Missing required field: ${field}`);
            }
        }
        validateFields(data);
        if (data.action === 'backup' && !data.backup_config) {
            throw new BadRequestException('backup_config required for backup action');
        }
        if (!validateCronExpression(data.cron_expression as string)) {
            throw new BadRequestException('Invalid cron expression');
        }
        const backupConfig =
            data.action === 'backup' ? toStoredBackupConfig(data.backup_config as string, data.target_type as string, null) : null;

        const now = nowSeconds();
        const id = this.db.write((db) => {
            const result = db
                .prepare(
                    `INSERT INTO schedules
                        (name, target_type, target_id, action, cron_expression, enabled,
                         backup_config, next_run_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    data.name as string,
                    data.target_type as string,
                    data.target_id as string,
                    data.action as string,
                    data.cron_expression as string,
                    data.enabled == null ? 1 : data.enabled ? 1 : 0,
                    backupConfig,
                    computeNextRun(data.cron_expression as string, now),
                    now,
                    now
                );
            return Number(result.lastInsertRowid);
        });

        this.events.publish('schedules', 'created');
        return id;
    }

    update(id: number, data: ScheduleWrite): boolean {
        // Existence first, as updateSchedule() does, so a missing id answers
        // 404 even when the body is also invalid.
        const stored = this.get(id);
        if (stored === null) throw new NotFoundException('Schedule not found');

        // The stored row fills in whatever a partial PUT leaves out, so
        // changing only `action` to 'update' on a stack schedule is still
        // checked against the target_type it will actually run against —
        // `$data + ['action'=>stored, 'target_type'=>stored]` in PHP.
        validateFields({
            ...data,
            action: data.action ?? stored.action,
            target_type: data.target_type ?? stored.target_type,
        });
        if (data.cron_expression != null && !validateCronExpression(data.cron_expression)) {
            throw new BadRequestException('Invalid cron expression');
        }

        this.db.write((db) => {
            const schedule = readRow(db, id);
            if (schedule === null) throw new NotFoundException('Schedule not found');

            const now = nowSeconds();
            const update: Record<string, string | number | null> = { updated_at: now };

            // The same five columns PHP copies, each only when present.
            for (const field of ['name', 'target_type', 'target_id', 'action'] as const) {
                if (data[field] !== undefined && data[field] !== null) update[field] = data[field] as string;
            }
            if (data.enabled !== undefined && data.enabled !== null) update.enabled = data.enabled ? 1 : 0;

            if (data.cron_expression != null) {
                update.cron_expression = data.cron_expression;
                update.next_run_at = computeNextRun(data.cron_expression, now);
            }

            // Turning a schedule back on must move it forward. A row disabled
            // last week still carries last week's next_run_at, which is in the
            // past and would fire on the very next tick.
            if (schedule.enabled === 0 && update.enabled === 1 && update.next_run_at === undefined) {
                update.next_run_at = computeNextRun(
                    (update.cron_expression as string | undefined) ?? schedule.cron_expression,
                    now
                );
            }

            if (data.backup_config !== undefined && data.backup_config !== null) {
                const targetType = data.target_type ?? schedule.target_type;
                const targetId = data.target_id ?? schedule.target_id;
                // A saved password never follows the schedule to a different target.
                const sameTarget = targetType === schedule.target_type && targetId === schedule.target_id;
                update.backup_config = toStoredBackupConfig(
                    data.backup_config,
                    targetType,
                    sameTarget ? schedule.backup_config : null
                );
            }

            // Column names come from the fixed list above, never from input.
            const columns = Object.keys(update);
            db.prepare(`UPDATE schedules SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
                ...columns.map((c) => update[c]),
                id
            );
        });

        this.events.publish('schedules', 'updated');
        return true;
    }

    delete(id: number): boolean {
        this.db.write((db) => {
            db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
        });
        this.events.publish('schedules', 'deleted');
        return true;
    }

    toggle(id: number, enabled: boolean): boolean {
        this.db.write((db) => setEnabled(db, id, enabled, nowSeconds()));
        this.events.publish('schedules', 'toggled');
        return true;
    }

    /** Rows may move in either direction in one call. Unknown ids are skipped. */
    bulkSetEnabled(updates: { id: number; enabled: boolean }[]): number {
        const changed = this.db.write((db) => {
            const now = nowSeconds();
            let count = 0;
            for (const entry of updates) {
                const id = Math.trunc(Number(entry.id));
                if (!id) continue;
                if (setEnabled(db, id, Boolean(entry.enabled), now)) count += 1;
            }
            return count;
        });
        this.events.publish('schedules', 'toggled');
        return changed;
    }

    /**
     * Counts the ids acted on, not the rows that existed, matching PHP, which
     * counts a delete of an id that was already gone.
     */
    bulkDelete(ids: number[]): number {
        const deleted = this.db.write((db) => {
            let count = 0;
            const remove = db.prepare('DELETE FROM schedules WHERE id = ?');
            for (const raw of ids) {
                const id = Math.trunc(Number(raw));
                if (!id) continue;
                remove.run(id);
                count += 1;
            }
            return count;
        });
        this.events.publish('schedules', 'deleted');
        return deleted;
    }

    history(scheduleId: number, limit = 50): ScheduleHistoryRow[] {
        return this.db.read(
            (db) =>
                db
                    .prepare(
                        'SELECT * FROM schedule_history WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?'
                    )
                    .all(scheduleId, limit) as unknown as ScheduleHistoryRow[]
        );
    }

    /** "Run now", and the second half of every automatic run. */
    async execute(id: number): Promise<RunResult> {
        const schedule = this.get(id);
        if (schedule === null) {
            return { success: false, schedule_id: id, status: 'error', message: 'Schedule not found' };
        }

        const about = aboutOf(schedule);

        // One run of a schedule at a time, as `ScheduleManager::executeSchedule`
        // does with its per-schedule flock. The runner claims its slot, but a
        // manual "Run now" is not tied to a slot, so a click in the minute the
        // runner picks the schedule up would run the action twice at once.
        // This guards this process only. Node cannot take PHP's flock, and in
        // GraphQL mode every "Run now" comes through this service anyway.
        if (this.runningIds.has(id)) {
            return { success: false, schedule_id: id, status: 'busy', message: 'This schedule is already running', ...about };
        }
        this.runningIds.add(id);

        if (schedule.action === 'update') {
            // A pull can take minutes. Neither `runDue()`'s loop nor a "Run
            // now" request should wait for it, so this starts the run and
            // answers 'started' at once, keeping the lock above until the
            // background run actually finishes. Its result then goes through
            // the same notification path an awaited run's does, and an
            // 'executed' event announces it — mirroring `run-schedule.php`,
            // which runs a detached update and does both itself when it ends.
            this.runSchedule(schedule, id, about)
                .then((result) => {
                    this.events.publish('schedules', 'executed');
                    notifyScheduleResult(result);
                })
                .catch((error: unknown) => {
                    // runSchedule() already turns a thrown action into an
                    // 'error' result internally; this only guards against
                    // something failing outside that, so it is at least
                    // logged rather than silently lost.
                    this.logger.error(`Background schedule run failed: ${String(error)}`);
                })
                .finally(() => {
                    this.runningIds.delete(id);
                });

            return { success: true, schedule_id: id, status: 'started', message: 'Started in the background', ...about };
        }

        try {
            return await this.runSchedule(schedule, id, about);
        } finally {
            this.runningIds.delete(id);
        }
    }

    private async runSchedule(schedule: ScheduleRow, id: number, about: ReturnType<typeof aboutOf>): Promise<RunResult> {
        const startedAt = nowSeconds();
        const historyId = this.db.write((db) =>
            Number(
                db
                    .prepare(
                        "INSERT INTO schedule_history (schedule_id, started_at, status) VALUES (?, ?, 'running')"
                    )
                    .run(id, startedAt).lastInsertRowid
            )
        );

        let outcome: ActionOutcome;
        let threw = false;
        try {
            outcome = await this.dispatch(schedule);
        } catch (error) {
            threw = true;
            outcome = { success: false, message: error instanceof Error ? error.message : String(error) };
        }

        const status = outcome.success ? 'success' : 'error';
        this.db.write((db) => {
            const now = nowSeconds();
            if (outcome.backup_file) {
                db.prepare(
                    'UPDATE schedule_history SET finished_at = ?, status = ?, message = ?, backup_file = ?, backup_size = ? WHERE id = ?'
                ).run(now, status, outcome.message, outcome.backup_file, outcome.backup_size ?? 0, historyId);
            } else {
                db.prepare('UPDATE schedule_history SET finished_at = ?, status = ?, message = ? WHERE id = ?').run(
                    now,
                    status,
                    outcome.message,
                    historyId
                );
            }
            db.prepare(
                `UPDATE schedules SET last_run_at = ?, last_run_status = ?, last_run_message = ?,
                    next_run_at = ?, updated_at = ? WHERE id = ?`
            ).run(startedAt, status, outcome.message, computeNextRun(schedule.cron_expression, now), now, id);
            // PHP prunes only on the path where the action returned. When it
            // threw, the catch block records the failure and stops there.
            if (!threw) pruneHistory(db, id);
        });

        return { success: outcome.success, schedule_id: id, status, message: outcome.message, ...about };
    }

    /**
     * Run everything that has come due, one schedule at a time.
     *
     * Sequential on purpose, as in PHP: two backups of the same share running
     * at once would fight over the disk, and a stop followed by a start on the
     * same container must happen in that order.
     */
    async runDue(now = nowSeconds()): Promise<RunResult[]> {
        const due = this.db.read(
            (db) =>
                db
                    .prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ?')
                    .all(now) as unknown as ScheduleRow[]
        );

        const results: RunResult[] = [];
        for (const schedule of due) {
            if (!this.claim(schedule, now)) continue;
            const lateBy = now - Number(schedule.next_run_at);
            if (shouldSkipMissedRun(schedule.action, lateBy, scheduleQuiesceMode(schedule))) {
                results.push(this.skip(schedule, lateBy));
                continue;
            }
            // `execute()` itself starts an `update` schedule detached and
            // answers 'started' at once, so this loop never blocks on one —
            // a pull behind it in the list still runs in its own minute.
            results.push(await this.execute(schedule.id));
        }
        return results;
    }

    /**
     * Take this slot, or learn that another runner already took it.
     *
     * Moves `next_run_at` past the slot only if it still holds the value this
     * runner read. PHP's runner and this one can both find the same schedule
     * due in the same minute, around a backend-mode switch or a restart, and
     * the SELECT alone lets both run it. The compare-and-set makes exactly one
     * of them win, because SQLite serializes the two writes.
     *
     * The run itself sets `next_run_at` again when it finishes, as before.
     *
     * This makes a slot run at most once. If the run fails after the claim
     * and before its history row, the slot is lost with no record, where
     * before the claim it was retried on the next tick. For a backup or a
     * restart, a lost run is the better failure than a doubled one.
     */
    private claim(schedule: ScheduleRow, now: number): boolean {
        return this.db.write(
            (db) =>
                Number(
                    db
                        .prepare('UPDATE schedules SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?')
                        .run(computeNextRun(schedule.cron_expression, now), schedule.id, schedule.next_run_at).changes
                ) === 1
        );
    }

    private skip(schedule: ScheduleRow, lateBy: number): RunResult {
        const now = nowSeconds();
        const message = `Skipped: ${formatRunLateness(lateBy)} past scheduled time`;

        this.db.write((db) => {
            db.prepare(
                "INSERT INTO schedule_history (schedule_id, started_at, finished_at, status, message) VALUES (?, ?, ?, 'skipped', ?)"
            ).run(schedule.id, now, now, message);
            // From now, never from the stale next_run_at. Advancing from the
            // missed slot lands on another past time, which is skipped again on
            // the next tick, writing a history row every minute forever.
            db.prepare(
                `UPDATE schedules SET last_run_at = ?, last_run_status = 'skipped', last_run_message = ?,
                    next_run_at = ?, updated_at = ? WHERE id = ?`
            ).run(now, message, computeNextRun(schedule.cron_expression, now), now, schedule.id);
            pruneHistory(db, schedule.id);
        });

        return { success: true, schedule_id: schedule.id, status: 'skipped', message, late_by: lateBy, ...aboutOf(schedule) };
    }

    private async dispatch(schedule: ScheduleRow): Promise<ActionOutcome> {
        if (schedule.action === 'backup') return this.executors.backup(schedule);
        if (schedule.target_type === 'container') {
            return this.executors.containerAction(schedule.target_id, schedule.action);
        }
        return this.executors.stackAction(schedule.target_id, schedule.action);
    }
}

/**
 * The allowlist `api/schedules.php`'s `validateScheduleFields` applies. Must
 * match the CHECK constraints, and checks only the fields present in `data`
 * so a partial PUT is validated the same way a full POST is.
 */
function validateFields(data: ScheduleWrite): void {
    if (data.target_type !== undefined && !(TARGET_TYPES as readonly string[]).includes(data.target_type)) {
        throw new BadRequestException('Invalid target_type');
    }
    if (data.action !== undefined && !(SCHEDULE_ACTIONS as readonly string[]).includes(data.action)) {
        throw new BadRequestException('Invalid action');
    }

    // A stack updates through Compose, which this action does not run.
    if (data.action === 'update' && data.target_type === 'stack') {
        throw new BadRequestException('Update is not supported for compose stacks');
    }
}

function readRow(db: DatabaseSync, id: number): ScheduleRow | null {
    return (db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined) ?? null;
}

/** Answers whether the row existed. Enabling moves next_run_at forward. */
function setEnabled(db: DatabaseSync, id: number, enabled: boolean, now: number): boolean {
    const row = db.prepare('SELECT cron_expression FROM schedules WHERE id = ?').get(id) as
        | { cron_expression: string }
        | undefined;
    if (row === undefined) return false;

    if (enabled) {
        db.prepare('UPDATE schedules SET enabled = 1, updated_at = ?, next_run_at = ? WHERE id = ?').run(
            now,
            computeNextRun(row.cron_expression, now),
            id
        );
    } else {
        db.prepare('UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?').run(now, id);
    }
    return true;
}

function pruneHistory(db: DatabaseSync, scheduleId: number): void {
    const cutoff = db
        .prepare(
            'SELECT started_at FROM schedule_history WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1 OFFSET ?'
        )
        .get(scheduleId, HISTORY_KEEP) as { started_at: number } | undefined;
    if (cutoff !== undefined && cutoff.started_at) {
        db.prepare('DELETE FROM schedule_history WHERE schedule_id = ? AND started_at < ?').run(
            scheduleId,
            cutoff.started_at
        );
    }
}

function aboutOf(schedule: ScheduleRow): Pick<RunResult, 'name' | 'target_type' | 'target_id' | 'action'> {
    return {
        name: schedule.name,
        target_type: schedule.target_type,
        target_id: schedule.target_id,
        action: schedule.action,
    };
}
