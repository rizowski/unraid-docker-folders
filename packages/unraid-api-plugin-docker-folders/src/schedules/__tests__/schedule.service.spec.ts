import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { nowSeconds } from '../../util/time.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { computeNextRun } from '../cron.js';
import { formatRunLateness } from '../schedule-notifications.js';
import {
    MISFIRE_GRACE_SECONDS,
    quiesceModeFor,
    scheduleQuiesceMode,
    ScheduleService,
    shouldSkipMissedRun,
    type ActionOutcome,
    type ScheduleExecutors,
    type ScheduleRow,
    type ScheduleWrite,
} from '../schedule.service.js';

/**
 * Ported from `tests/php/ScheduleManagerTest.php` and `ScheduleActionTest.php`,
 * against `ScheduleService` and the validation `api/schedules.php` used to do
 * before calling `ScheduleManager` — both now live in `schedule.service.ts`.
 */

function fakeExecutors() {
    const state = {
        containerAction: async (
            _name: string,
            _action: string
        ): Promise<ActionOutcome> => ({ success: true, message: 'container ok' }),
        stackAction: async (
            _name: string,
            _action: string
        ): Promise<ActionOutcome> => ({ success: true, message: 'stack ok' }),
        backup: async (_schedule: ScheduleRow): Promise<ActionOutcome> => ({
            success: true,
            message: 'backup ok',
            backup_file: '/backups/plex-2026.tar.gz',
            backup_size: 1024,
        }),
    };

    const executors: ScheduleExecutors = {
        containerAction: (name, action) => state.containerAction(name, action),
        stackAction: (name, action) => state.stackAction(name, action),
        backup: (schedule) => state.backup(schedule),
    };

    return { executors, state };
}

function fakeEvents(): EventBusService {
    return { publish: vi.fn() } as unknown as EventBusService;
}

describe('ScheduleService', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let events: EventBusService;
    let exec: ReturnType<typeof fakeExecutors>;
    let service: ScheduleService;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        events = fakeEvents();
        exec = fakeExecutors();
        service = new ScheduleService(db, events, exec.executors);
    });

    afterEach(() => {
        temp.cleanup();
    });

    /** Directly overwrite a column PHP-style, past the service under test. */
    function patchRow(id: number, columns: Record<string, string | number | null>): void {
        const keys = Object.keys(columns);
        db.write((handle) =>
            handle
                .prepare(`UPDATE schedules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
                .run(...keys.map((k) => columns[k]), id)
        );
    }

    function getRow(id: number): ScheduleRow {
        const [row] = temp.rows('SELECT * FROM schedules WHERE id = ?', [id]);
        return row as unknown as ScheduleRow;
    }

    const baseContainer = {
        name: 'Nightly restart',
        target_type: 'container',
        target_id: 'plex',
        action: 'restart',
        cron_expression: '0 3 * * *',
    };

    describe('create', () => {
        it.each(['name', 'target_type', 'target_id', 'action', 'cron_expression'] as const)(
            'requires %s, with the exact PHP message',
            (field) => {
                const data = { ...baseContainer } as Record<string, unknown>;
                delete data[field];

                expect(() => service.create(data as ScheduleWrite)).toThrow(`Missing required field: ${field}`);
                expect(() => service.create(data as ScheduleWrite)).toThrow(BadRequestException);
            }
        );

        it('rejects a target_type outside the allowlist', () => {
            expect(() => service.create({ ...baseContainer, target_type: 'vm' })).toThrow('Invalid target_type');
        });

        it('rejects an action outside the allowlist', () => {
            expect(() => service.create({ ...baseContainer, action: 'delete' })).toThrow('Invalid action');
        });

        it('rejects a malformed cron expression', () => {
            expect(() => service.create({ ...baseContainer, cron_expression: 'not a cron' })).toThrow(
                'Invalid cron expression'
            );
        });

        it('requires backup_config for a backup action', () => {
            expect(() =>
                service.create({ ...baseContainer, action: 'backup', backup_config: undefined })
            ).toThrow('backup_config required for backup action');
        });

        it('accepts a backup action carrying backup_config', () => {
            const id = service.create({
                ...baseContainer,
                action: 'backup',
                backup_config: '{"paths":["/config"]}',
            });

            expect(getRow(id).backup_config).toBe('{"paths":["/config"]}');
        });

        it('drops backup_config when the action is not backup', () => {
            const id = service.create({ ...baseContainer, backup_config: '{"paths":["/config"]}' });

            expect(getRow(id).backup_config).toBeNull();
        });

        it('computes next_run_at from the cron expression', () => {
            const now = 1_800_000_000; // fixed, arbitrary anchor
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(now * 1000);
            try {
                const id = service.create(baseContainer);
                expect(getRow(id).next_run_at).toBe(computeNextRun(baseContainer.cron_expression, now));
            } finally {
                vi.useRealTimers();
            }
        });

        it('defaults enabled to 1 when not sent', () => {
            const id = service.create(baseContainer);
            expect(getRow(id).enabled).toBe(1);
        });

        it('stores enabled: false as 0', () => {
            const id = service.create({ ...baseContainer, enabled: false });
            expect(getRow(id).enabled).toBe(0);
        });

        /**
         * BUG, not fixed here per instructions: PHP's create checks
         * `isset($data['enabled'])`, which is false for an explicit `null` and
         * falls back to enabled=1. `schedule.service.ts`'s
         * `data.enabled === undefined ? 1 : data.enabled ? 1 : 0` treats `null`
         * as a real, falsy value and stores 0 instead. `enabled: null` is
         * reachable from GraphQL: `DockerFoldersScheduleInput.enabled` is
         * `@IsOptional()`, which lets `null` straight through the pipe (see
         * `schedule.model.spec.ts`). Recommended fix: change the ternary at
         * `schedule.service.ts` (create, around line 199) to
         * `data.enabled == null ? 1 : data.enabled ? 1 : 0`, matching the
         * `!= null` / `== null` checks the rest of the file already uses for
         * "isset" semantics.
         */
        // PHP's isset(): an explicit null means absent, so the default applies.
        it('treats enabled: null as absent and defaults it on, like PHP', () => {
            const id = service.create({ ...baseContainer, enabled: null as unknown as undefined });
            expect(getRow(id).enabled).toBe(1);
        });

        // PHP's empty() treats "0" as missing.
        it('rejects a required field whose value is the string "0", like PHP', () => {
            expect(() => service.create({ ...baseContainer, name: '0' })).toThrow('Missing required field: name');
        });

        it('announces the create', () => {
            service.create(baseContainer);
            expect(events.publish).toHaveBeenCalledWith('schedules', 'created');
        });
    });

    describe('update', () => {
        // updateSchedule() looks the row up before it validates anything.
        it('answers not found before validating the body, like PHP', () => {
            expect(() => service.update(99999, { cron_expression: 'not cron' })).toThrow('Schedule not found');
        });

        function seed(overrides: Partial<ScheduleWrite> = {}): number {
            return service.create({ ...baseContainer, ...overrides });
        }

        it('changes only the fields sent', () => {
            const id = seed();

            service.update(id, { name: 'Renamed' });

            const row = getRow(id);
            expect(row.name).toBe('Renamed');
            expect(row.target_id).toBe('plex');
            expect(row.action).toBe('restart');
            expect(row.cron_expression).toBe('0 3 * * *');
        });

        it('treats an explicit null as absent, the way PHP isset does', () => {
            const id = seed();

            service.update(id, { name: null as unknown as undefined });

            expect(getRow(id).name).toBe('Nightly restart');
        });

        it('recomputes next_run_at when cron_expression changes', () => {
            const id = seed();
            const before = getRow(id).next_run_at;

            service.update(id, { cron_expression: '*/5 * * * *' });

            const after = getRow(id);
            expect(after.cron_expression).toBe('*/5 * * * *');
            expect(after.next_run_at).not.toBe(before);
            expect(after.next_run_at).toBe(computeNextRun('*/5 * * * *', after.updated_at));
        });

        it('moves a stale next_run_at forward when re-enabling, even without a new cron', () => {
            const id = seed({ enabled: false });
            // Simulate a row that has sat disabled since last week: its
            // next_run_at is long in the past.
            const staleNextRun = nowSeconds() - 7 * 86400;
            patchRow(id, { next_run_at: staleNextRun });

            service.update(id, { enabled: true });

            const after = getRow(id);
            expect(after.enabled).toBe(1);
            expect(after.next_run_at).toBeGreaterThan(staleNextRun);
            expect(after.next_run_at).toBeGreaterThanOrEqual(nowSeconds());
        });

        it('leaves next_run_at alone when a field other than cron or enabled changes', () => {
            const id = seed();
            const before = getRow(id).next_run_at;

            service.update(id, { target_id: 'sonarr' });

            expect(getRow(id).next_run_at).toBe(before);
        });

        it('rejects a malformed cron expression', () => {
            const id = seed();
            expect(() => service.update(id, { cron_expression: 'nope' })).toThrow('Invalid cron expression');
        });

        it('throws NotFoundException for a missing id', () => {
            expect(() => service.update(999_999, { name: 'ghost' })).toThrow(NotFoundException);
            expect(() => service.update(999_999, { name: 'ghost' })).toThrow('Schedule not found');
        });

        it('announces the update', () => {
            const id = seed();
            service.update(id, { name: 'x' });
            expect(events.publish).toHaveBeenCalledWith('schedules', 'updated');
        });
    });

    describe('toggle', () => {
        it('flips enabled and recomputes next_run_at when turning on', () => {
            const id = service.create({ ...baseContainer, enabled: false });
            const staleNextRun = nowSeconds() - 3600;
            patchRow(id, { next_run_at: staleNextRun });

            service.toggle(id, true);

            const row = getRow(id);
            expect(row.enabled).toBe(1);
            expect(row.next_run_at).toBeGreaterThan(staleNextRun);
        });

        it('flips enabled off without touching next_run_at', () => {
            const id = service.create(baseContainer);
            const before = getRow(id).next_run_at;

            service.toggle(id, false);

            const row = getRow(id);
            expect(row.enabled).toBe(0);
            expect(row.next_run_at).toBe(before);
        });

        it('announces the toggle', () => {
            const id = service.create(baseContainer);
            service.toggle(id, false);
            expect(events.publish).toHaveBeenCalledWith('schedules', 'toggled');
        });
    });

    describe('bulkSetEnabled', () => {
        it('moves rows in either direction in one call', () => {
            const a = service.create({ ...baseContainer, enabled: false });
            const b = service.create({ ...baseContainer, target_id: 'sonarr', enabled: true });

            const changed = service.bulkSetEnabled([
                { id: a, enabled: true },
                { id: b, enabled: false },
            ]);

            expect(changed).toBe(2);
            expect(getRow(a).enabled).toBe(1);
            expect(getRow(b).enabled).toBe(0);
        });

        it('skips an id that does not exist, and does not count it', () => {
            const a = service.create(baseContainer);

            const changed = service.bulkSetEnabled([
                { id: a, enabled: false },
                { id: 999_999, enabled: true },
            ]);

            expect(changed).toBe(1);
        });

        it('skips id 0', () => {
            const changed = service.bulkSetEnabled([{ id: 0, enabled: true }]);
            expect(changed).toBe(0);
        });
    });

    describe('bulkDelete', () => {
        it('counts every id acted on, even one that was already gone (PHP parity)', () => {
            const a = service.create(baseContainer);

            const deleted = service.bulkDelete([a, 999_999]);

            expect(deleted).toBe(2);
            expect(temp.rows('SELECT * FROM schedules')).toEqual([]);
        });

        it('skips id 0 and does not count it', () => {
            const deleted = service.bulkDelete([0]);
            expect(deleted).toBe(0);
        });
    });

    describe('execute', () => {
        it('answers "Schedule not found" for a missing id', async () => {
            const result = await service.execute(999_999);
            expect(result).toEqual({
                success: false,
                schedule_id: 999_999,
                status: 'error',
                message: 'Schedule not found',
            });
        });

        it('answers busy for a second run of the same schedule while the first is running', async () => {
            const releases: Array<() => void> = [];
            exec.state.containerAction = () =>
                new Promise((resolve) => {
                    releases.push(() => resolve({ success: true, message: 'container ok' }));
                });
            const id = service.create(baseContainer);
            const other = service.create({ ...baseContainer, name: 'Other', target_id: 'sonarr' });

            const first = service.execute(id);
            const second = await service.execute(id);
            expect(second).toMatchObject({
                success: false,
                schedule_id: id,
                status: 'busy',
                message: 'This schedule is already running',
                name: 'Nightly restart',
            });
            expect(temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id])).toHaveLength(1);

            // A different schedule is not held up.
            const otherRun = service.execute(other);
            await vi.waitFor(() => expect(releases).toHaveLength(2));
            releases.forEach((release) => release());
            expect((await first).status).toBe('success');
            expect((await otherRun).status).toBe('success');

            // Free again once the first run finished.
            exec.state.containerAction = async () => ({ success: true, message: 'container ok' });
            expect((await service.execute(id)).status).toBe('success');
        });

        it('records a history row from running to success, and updates last_run_*', async () => {
            const id = service.create(baseContainer);

            const result = await service.execute(id);

            expect(result.status).toBe('success');
            const [history] = temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id]);
            expect(history.status).toBe('success');
            expect(history.finished_at).not.toBeNull();

            const row = getRow(id);
            expect(row.last_run_status).toBe('success');
            expect(row.last_run_message).toBe('container ok');
            expect(row.last_run_at).not.toBeNull();
        });

        it('records history as error when the executor reports failure', async () => {
            exec.state.containerAction = async () => ({ success: false, message: 'container missing' });
            const id = service.create(baseContainer);

            const result = await service.execute(id);

            expect(result.status).toBe('error');
            expect(result.success).toBe(false);
            expect(getRow(id).last_run_status).toBe('error');
        });

        it('records backup_file and backup_size only for a backup action', async () => {
            const id = service.create({
                ...baseContainer,
                action: 'backup',
                backup_config: '{"paths":["/config"]}',
            });

            await service.execute(id);

            const [history] = temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id]);
            expect(history.backup_file).toBe('/backups/plex-2026.tar.gz');
            expect(history.backup_size).toBe(1024);
        });

        it('leaves backup_file and backup_size null for a non-backup action', async () => {
            const id = service.create(baseContainer);

            await service.execute(id);

            const [history] = temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id]);
            expect(history.backup_file).toBeNull();
            expect(history.backup_size).toBeNull();
        });

        it('records an error and does NOT prune history when the executor throws (PHP parity)', async () => {
            const id = service.create(baseContainer);
            exec.state.containerAction = async () => {
                throw new Error('docker socket unreachable');
            };

            const result = await service.execute(id);

            expect(result.status).toBe('error');
            expect(result.message).toBe('docker socket unreachable');
            const [history] = temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id]);
            expect(history.status).toBe('error');
            expect(history.message).toBe('docker socket unreachable');
        });
    });

    describe('history pruning', () => {
        // pruneHistory (both here and in ScheduleManager.php) reads the
        // started_at at OFFSET 200 and deletes rows strictly *before* it
        // (`started_at < cutoff`), so the cutoff row itself survives: with
        // distinct per-run timestamps the true steady state is 201 rows, not
        // 200. That off-by-one is shared byte-for-byte with PHP's identical
        // SQL, so it is documented here rather than reported as a divergence.
        // Real wall-clock time is faked and advanced a full second per run,
        // because a tight loop of 200+ executes can otherwise complete inside
        // one wall-clock second, which would tie every started_at together and
        // make the DELETE's strict "<" prune nothing at all.
        async function runManyTimes(id: number, count: number, startAt: number): Promise<void> {
            vi.useFakeTimers({ toFake: ['Date'] });
            try {
                for (let i = 0; i < count; i++) {
                    vi.setSystemTime((startAt + i) * 1000);
                    await service.execute(id);
                }
            } finally {
                vi.useRealTimers();
            }
        }

        it('settles at 201 rows once more than that have run successfully', async () => {
            const id = service.create({ ...baseContainer, cron_expression: '* * * * *' });

            await runManyTimes(id, 205, nowSeconds());

            expect(temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id])).toHaveLength(201);
        });

        it('does not prune when a run throws, so history can grow past the steady state', async () => {
            const id = service.create({ ...baseContainer, cron_expression: '* * * * *' });
            const start = nowSeconds();
            await runManyTimes(id, 201, start);
            expect(temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id])).toHaveLength(201);

            exec.state.containerAction = async () => {
                throw new Error('boom');
            };
            vi.useFakeTimers({ toFake: ['Date'] });
            try {
                vi.setSystemTime((start + 201) * 1000);
                await service.execute(id);
            } finally {
                vi.useRealTimers();
            }

            expect(
                temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id]).length
            ).toBeGreaterThan(201);
        });
    });

    describe('runDue', () => {
        function dueRow(overrides: Partial<ScheduleWrite>, nextRunAt: number): number {
            const id = service.create({ ...baseContainer, ...overrides });
            patchRow(id, { next_run_at: nextRunAt });
            return id;
        }

        it('selects only enabled rows whose next_run_at has passed', async () => {
            const now = nowSeconds();
            const due = dueRow({}, now - 5);
            dueRow({ enabled: false }, now - 5); // disabled: not selected
            dueRow({}, now + 3600); // in the future: not selected

            const results = await service.runDue(now);

            expect(results.map((r) => r.schedule_id)).toEqual([due]);
        });

        it('skips a start/stop/restart run more than the grace window late, and recomputes next_run_at from now, not the stale slot', async () => {
            const now = nowSeconds();
            const lateBy = MISFIRE_GRACE_SECONDS + 100;
            const id = dueRow({ cron_expression: '*/5 * * * *' }, now - lateBy);

            const [result] = await service.runDue(now);

            expect(result.status).toBe('skipped');
            expect(result.message).toBe(`Skipped: ${formatRunLateness(lateBy)} past scheduled time`);

            const row = getRow(id);
            expect(row.next_run_at).toBe(computeNextRun('*/5 * * * *', now));
            // Not derived from the stale slot: that would land in the past again.
            expect(row.next_run_at).toBeGreaterThan(now);

            const [history] = temp.rows('SELECT * FROM schedule_history WHERE schedule_id = ?', [id]);
            expect(history.status).toBe('skipped');
        });

        it('does not skip a run inside the grace window', async () => {
            const now = nowSeconds();
            const id = dueRow({}, now - 90);

            const [result] = await service.runDue(now);

            expect(result.status).not.toBe('skipped');
            expect(result.schedule_id).toBe(id);
        });

        it('does not skip a late backup with quiesce "none"', async () => {
            const now = nowSeconds();
            const lateBy = MISFIRE_GRACE_SECONDS + 100;
            const id = dueRow(
                {
                    action: 'backup',
                    backup_config: '{"paths":["/config"],"quiesce":"none"}',
                },
                now - lateBy
            );

            const [result] = await service.runDue(now);

            expect(result.status).not.toBe('skipped');
            expect(result.schedule_id).toBe(id);
        });

        it.each(['pause', 'stop'])('skips a late backup with quiesce "%s"', async (quiesce) => {
            const now = nowSeconds();
            const lateBy = MISFIRE_GRACE_SECONDS + 100;
            dueRow(
                {
                    action: 'backup',
                    backup_config: `{"paths":["/config"],"quiesce":"${quiesce}"}`,
                },
                now - lateBy
            );

            const [result] = await service.runDue(now);

            expect(result.status).toBe('skipped');
        });

        it('runs a slot once when two runners find it due in the same minute', async () => {
            // PHP's runner and this one can both be awake around a mode switch.
            // A second service on the same file stands in for the other one.
            const other = new ScheduleService(new DatabaseService(temp.path), fakeEvents(), exec.executors);
            let calls = 0;
            let release: () => void = () => undefined;
            exec.state.containerAction = () => {
                calls += 1;
                return new Promise<ActionOutcome>((resolve) => {
                    release = () => resolve({ success: true, message: 'ok' });
                });
            };

            const now = nowSeconds();
            const id = dueRow({ cron_expression: '*/5 * * * *' }, now - 5);

            const first = service.runDue(now);
            // The first run is still going, so its own end-of-run write has not
            // moved next_run_at yet. Only the claim stands in the way.
            await vi.waitFor(() => expect(calls).toBe(1));
            const second = await other.runDue(now);
            release();
            await first;

            expect(second).toEqual([]);
            expect(calls).toBe(1);
            expect(temp.rows('SELECT id FROM schedule_history WHERE schedule_id = ?', [id])).toHaveLength(1);
        });

        it('does not run a slot whose next_run_at changed after the runner read it', async () => {
            const now = nowSeconds();
            const id = dueRow({}, now - 5);
            const stale = getRow(id);
            // Another runner claimed it between this runner's SELECT and claim.
            patchRow(id, { next_run_at: now + 3600 });

            const claimed = (service as unknown as { claim(row: ScheduleRow, now: number): boolean }).claim(stale, now);

            expect(claimed).toBe(false);
            expect(getRow(id).next_run_at).toBe(now + 3600);
        });

        it('runs due schedules one at a time, never concurrently', async () => {
            const order: string[] = [];
            const releases: Array<() => void> = [];
            exec.state.containerAction = (name: string) =>
                new Promise<ActionOutcome>((resolve) => {
                    order.push(`start:${name}`);
                    releases.push(() => {
                        order.push(`end:${name}`);
                        resolve({ success: true, message: 'ok' });
                    });
                });

            const now = nowSeconds();
            dueRow({ target_id: 'a' }, now);
            dueRow({ target_id: 'b' }, now);

            const promise = service.runDue(now);

            // Only the first schedule may have started; the loop must not
            // move on to the second until the first's promise settles.
            await vi.waitFor(() => expect(order).toEqual(['start:a']));
            releases[0]();

            await vi.waitFor(() => expect(order).toEqual(['start:a', 'end:a', 'start:b']));
            releases[1]();

            await promise;
            expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
        });
    });
});

/**
 * Pure-function ports of `ScheduleManager::shouldSkipMissedRun`,
 * `::scheduleQuiesceMode`, and `BackupManager::quiesceModeFor`, exercised
 * directly (no database) the same way `ScheduleManagerTest.php` does.
 */
describe('shouldSkipMissedRun', () => {
    it('skips a restart far past its slot', () => {
        expect(shouldSkipMissedRun('restart', 6 * 3600 + 40 * 60, 'none')).toBe(true);
        expect(shouldSkipMissedRun('stop', 3600, 'none')).toBe(true);
    });

    it('runs inside the grace window', () => {
        expect(shouldSkipMissedRun('restart', 0, 'none')).toBe(false);
        expect(shouldSkipMissedRun('restart', 90, 'none')).toBe(false);
        expect(shouldSkipMissedRun('restart', 300, 'none')).toBe(false);
    });

    it('lets a read-only backup catch up', () => {
        expect(shouldSkipMissedRun('backup', 6 * 3600 + 40 * 60, 'none')).toBe(false);
    });

    it('skips a backup that pauses or stops when it is late', () => {
        expect(shouldSkipMissedRun('backup', 6 * 3600 + 40 * 60, 'stop')).toBe(true);
        expect(shouldSkipMissedRun('backup', 3600, 'pause')).toBe(true);
        expect(shouldSkipMissedRun('backup', 90, 'pause')).toBe(false);
    });
});

describe('quiesceModeFor', () => {
    it('coerces anything unknown to none', () => {
        expect(quiesceModeFor('destroy')).toBe('none');
        expect(quiesceModeFor(undefined)).toBe('none');
        expect(quiesceModeFor(null)).toBe('none');
        expect(quiesceModeFor(42)).toBe('none');
    });

    it('accepts pause and stop, case-insensitively', () => {
        expect(quiesceModeFor('PAUSE')).toBe('pause');
        expect(quiesceModeFor('Stop')).toBe('stop');
    });
});

describe('scheduleQuiesceMode', () => {
    it('reads the quiesce mode off backup_config JSON', () => {
        expect(
            scheduleQuiesceMode({ action: 'backup', backup_config: '{"paths":["/config"],"quiesce":"stop"}' })
        ).toBe('stop');
    });

    it('defaults to none for a schedule saved before the field existed', () => {
        expect(scheduleQuiesceMode({ action: 'backup', backup_config: '{"paths":["/config"]}' })).toBe('none');
    });

    it('coerces junk without throwing, mid-run', () => {
        expect(scheduleQuiesceMode({ action: 'backup', backup_config: '{"quiesce":"destroy"}' })).toBe('none');
    });

    it('is none for anything that is not a backup', () => {
        expect(scheduleQuiesceMode({ action: 'restart', backup_config: null })).toBe('none');
    });
});
