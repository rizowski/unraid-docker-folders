import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `SchedulerService` imports `existsSync`/`readFileSync`/`statSync`/
 * `utimesSync`/`openSync`/`closeSync` as named ESM bindings straight from
 * `node:fs`. `vi.spyOn` cannot intercept a named import like that — the
 * module has already bound the export by the time a spy could reach it — so
 * the whole module is replaced instead, with everything but the six
 * functions this suite drives left as the real implementation (so
 * `createMigratedDatabase`, which itself uses `readdirSync`/`readFileSync`/
 * `mkdtempSync`/`rmSync`, keeps working).
 */
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: vi.fn(actual.existsSync),
        readFileSync: vi.fn(actual.readFileSync),
        statSync: vi.fn(actual.statSync),
        utimesSync: vi.fn(),
        openSync: vi.fn(),
        closeSync: vi.fn(),
        writeFileSync: vi.fn(),
        unlinkSync: vi.fn(),
    };
});

/**
 * Real `buildScheduleFailureNotification`/`buildScheduleSkipNotification`
 * (so the assertions below compare against the actual text), with only
 * `sendUnraidNotification` stubbed so no real process is spawned.
 */
vi.mock('../schedule-notifications.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../schedule-notifications.js')>();
    return { ...actual, sendUnraidNotification: vi.fn() };
});

import { closeSync, existsSync, openSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';

import { DOCKER_SOCKET_PATH } from '../../containers/docker-client.js';
import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import {
    buildScheduleFailureNotification,
    buildScheduleSkipNotification,
    sendUnraidNotification,
} from '../schedule-notifications.js';
import type { RunResult, ScheduleService } from '../schedule.service.js';
import { RUNNER_ALIVE_FILE,
    SCHEDULER_TICK_FILE, SCHEDULER_TICK_STALE_SECONDS, SchedulerService } from '../scheduler.service.js';

/** The exact string `scheduler.service.ts` looks for in config.php's text. */
const PHP_GATE_MARKER = 'function dfmPluginRunnerOwns(';

describe('SchedulerService', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let events: EventBusService;
    let runDue: ReturnType<typeof vi.fn>;
    let schedules: ScheduleService;
    let service: SchedulerService;
    let realFs: typeof import('node:fs');
    let runScheduledCheck: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        // `createMigratedDatabase()` itself calls the real `readdirSync`/
        // `readFileSync`, so every mocked function is put back to the real
        // implementation *before* it runs, and only then given this suite's
        // fake behavior. `vi.clearAllMocks()` in `afterEach` resets call
        // history, but not a `mockImplementation` set by a previous test, so
        // skipping this reset would leak one test's fake config.php content
        // into the next test's migration read and crash it.
        realFs ??= await vi.importActual<typeof import('node:fs')>('node:fs');
        vi.mocked(readFileSync).mockImplementation(realFs.readFileSync);
        vi.mocked(existsSync).mockImplementation(realFs.existsSync);
        vi.mocked(statSync).mockImplementation(realFs.statSync);

        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        events = { publish: vi.fn() } as unknown as EventBusService;
        runDue = vi.fn(async (): Promise<RunResult[]> => []);
        schedules = { runDue } as unknown as ScheduleService;
        runScheduledCheck = vi.fn().mockResolvedValue(undefined);
        service = new SchedulerService(schedules, db, events, { runScheduledCheck } as never);

        // Defaults: PHP has not defined the gate (so ownsBackgroundWork() is
        // false out of the box), and the Docker socket is present. Each test
        // overrides what it needs.
        vi.mocked(readFileSync).mockImplementation(() => {
            throw new Error('ENOENT (test default: no config.php on disk)');
        });
        vi.mocked(existsSync).mockImplementation((path) => path === DOCKER_SOCKET_PATH);
        vi.mocked(statSync).mockImplementation(() => {
            throw new Error('ENOENT');
        });
    });

    afterEach(() => {
        temp.cleanup();
        vi.clearAllMocks();
    });

    function setBackendMode(mode: string): void {
        db.write((handle) => {
            handle
                .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('backend_mode', ?, 0)")
                .run(mode);
        });
    }

    function phpOwnsBackgroundWorkIsDefined(): void {
        vi.mocked(readFileSync).mockImplementation(
            () => `<?php\n${PHP_GATE_MARKER}) { return true; }\n`
        );
    }

    describe('ownsBackgroundWork gate', () => {
        it('does nothing when PHP has not defined the gate function, regardless of backend_mode', async () => {
            setBackendMode('graphql');
            // readFileSync still throws (test default): PHP predates the gate.

            await service.tick();

            expect(runDue).not.toHaveBeenCalled();
            expect(utimesSync).not.toHaveBeenCalled();
            expect(openSync).not.toHaveBeenCalled();
        });

        it('does nothing when the gate is defined but backend_mode is not graphql', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('php');

            await service.tick();

            expect(runDue).not.toHaveBeenCalled();
        });

        it('does nothing when backend_mode has never been set', async () => {
            phpOwnsBackgroundWorkIsDefined();

            await service.tick();

            expect(runDue).not.toHaveBeenCalled();
        });

        it('runs due schedules and touches the heartbeat when both conditions hold', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');

            const now = 1_800_000_000;
            await service.tick(now);

            expect(runDue).toHaveBeenCalledWith(now);
            // The heartbeat file did not exist (existsSync only returns true
            // for the Docker socket in this suite's default), so touch() takes
            // the create-a-new-file branch.
            expect(openSync).toHaveBeenCalledWith(SCHEDULER_TICK_FILE, 'w');
            expect(closeSync).toHaveBeenCalled();
        });

        it('touches an existing heartbeat file by updating its mtime instead of recreating it', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');
            vi.mocked(existsSync).mockImplementation(
                (path) =>
                    path === DOCKER_SOCKET_PATH || path === SCHEDULER_TICK_FILE
            );

            await service.tick();

            expect(utimesSync).toHaveBeenCalled();
            expect(openSync).not.toHaveBeenCalled();
        });

        // PHP stands down while this file is fresh, so it has to be touched
        // whenever this runner could own the work, even in PHP mode, and never
        // when the installed PHP lacks the gate that reads it.
        it('touches the runner-alive file in PHP mode but runs nothing', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('php');
            vi.mocked(existsSync).mockImplementation(() => false);

            await service.tick();

            expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(RUNNER_ALIVE_FILE, 'schedules update-checks\n');
            expect(runDue).not.toHaveBeenCalled();
        });

        it('does not run due schedules when the Docker socket is absent, even though it still touches the heartbeat', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');
            vi.mocked(existsSync).mockImplementation(() => false);

            await service.tick();

            expect(runDue).not.toHaveBeenCalled();
            // touch() runs before the socket check, unlike PHP, which touches
            // first too - this proves a stopped Docker daemon does not itself
            // look like a dead runner.
            expect(openSync).toHaveBeenCalled();
        });

        it('treats an unreadable database as "not mine to run", not as permission to run', async () => {
            phpOwnsBackgroundWorkIsDefined();
            temp.cleanup(); // the database file is now gone

            await expect(service.tick()).resolves.toBeUndefined();
            expect(runDue).not.toHaveBeenCalled();
        });
    });

    describe('update checks', () => {
        // 1_800_000_000 is exactly on the hour, so "hourly" is due in that minute.
        const onTheHour = 1_800_000_000;

        function updateSettings(enabled: string, schedule: string): void {
            db.write((handle) => {
                const put = handle.prepare(
                    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 0)'
                );
                put.run('enable_update_checks', enabled);
                put.run('update_check_schedule', schedule);
            });
        }

        beforeEach(() => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');
        });

        it('runs the check in the minute the chosen schedule matches, at any second of it', async () => {
            updateSettings('1', 'hourly');

            await service.tick(onTheHour + 42);

            expect(runScheduledCheck).toHaveBeenCalledTimes(1);
        });

        it('does not run the check in a minute the schedule does not match', async () => {
            updateSettings('1', 'hourly');

            await service.tick(onTheHour + 60);

            expect(runScheduledCheck).not.toHaveBeenCalled();
        });

        it('does not run the check when update checks are off', async () => {
            updateSettings('0', 'hourly');

            await service.tick(onTheHour);

            expect(runScheduledCheck).not.toHaveBeenCalled();
        });

        it('ignores a schedule name that is not one of the four', async () => {
            updateSettings('1', '* * * * *');

            await service.tick(onTheHour);

            expect(runScheduledCheck).not.toHaveBeenCalled();
        });

        it('leaves the check to PHP in PHP mode', async () => {
            setBackendMode('php');
            updateSettings('1', 'hourly');

            await service.tick(onTheHour);

            expect(runScheduledCheck).not.toHaveBeenCalled();
        });

        it('does not start a second check while one is still running', async () => {
            updateSettings('1', 'hourly');
            let finish: () => void = () => undefined;
            runScheduledCheck.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));

            await service.tick(onTheHour);
            await service.tick(onTheHour + 30);
            expect(runScheduledCheck).toHaveBeenCalledTimes(1);

            finish();
            await vi.waitFor(() => expect(runScheduledCheck).toHaveBeenCalledTimes(1));
        });

        it('does not hold up due schedules while the check runs', async () => {
            updateSettings('1', 'hourly');
            runScheduledCheck.mockReturnValueOnce(new Promise<void>(() => undefined));

            await service.tick(onTheHour);

            expect(runDue).toHaveBeenCalledWith(onTheHour);
        });

        it('logs a failed check instead of letting it escape the tick', async () => {
            updateSettings('1', 'hourly');
            runScheduledCheck.mockRejectedValueOnce(new Error('registry down'));

            await expect(service.tick(onTheHour)).resolves.toBeUndefined();
        });
    });

    describe('startup', () => {
        it('writes the runner-alive file at once, before the first tick', () => {
            vi.useFakeTimers();
            try {
                phpOwnsBackgroundWorkIsDefined();

                service.onModuleInit();

                expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(RUNNER_ALIVE_FILE, 'schedules update-checks\n');
                expect(runDue).not.toHaveBeenCalled();
            } finally {
                service.onModuleDestroy();
                vi.useRealTimers();
            }
        });

        it('writes nothing when PHP predates the gate', () => {
            vi.useFakeTimers();
            try {
                service.onModuleInit();

                expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
            } finally {
                service.onModuleDestroy();
                vi.useRealTimers();
            }
        });
    });

    describe('re-entrancy', () => {
        it('does not start a second pass while the first is still running', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');

            let release!: (results: RunResult[]) => void;
            runDue.mockImplementation(
                () =>
                    new Promise<RunResult[]>((resolve) => {
                        release = resolve;
                    })
            );

            const first = service.tick();
            const second = service.tick(); // must see `running` and bail before calling runDue again

            expect(runDue).toHaveBeenCalledTimes(1);
            release([]);
            await Promise.all([first, second]);

            expect(runDue).toHaveBeenCalledTimes(1);
        });

        it('runs again on the next tick once the previous pass has finished', async () => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');

            await service.tick();
            await service.tick();

            expect(runDue).toHaveBeenCalledTimes(2);
        });
    });

    describe('notifications', () => {
        function result(overrides: Partial<RunResult>): RunResult {
            return {
                success: true,
                schedule_id: 1,
                status: 'success',
                message: 'ok',
                name: 'Nightly restart',
                target_type: 'container',
                target_id: 'plex',
                action: 'restart',
                ...overrides,
            };
        }

        beforeEach(() => {
            phpOwnsBackgroundWorkIsDefined();
            setBackendMode('graphql');
        });

        it('sends a normal-importance notification for a skipped run', async () => {
            const skipped = result({ status: 'skipped', message: 'Skipped: 10m past scheduled time', late_by: 600 });
            runDue.mockResolvedValue([skipped]);

            await service.tick();

            const expected = buildScheduleSkipNotification(skipped, 600);
            expect(sendUnraidNotification).toHaveBeenCalledWith(expected, 'normal');
        });

        it('sends a warning-importance notification for a failed run', async () => {
            const failed = result({ success: false, status: 'error', message: 'container missing' });
            runDue.mockResolvedValue([failed]);

            await service.tick();

            const expected = buildScheduleFailureNotification(failed, 'container missing');
            expect(sendUnraidNotification).toHaveBeenCalledWith(expected, 'warning');
        });

        it('sends no notification for a successful run', async () => {
            runDue.mockResolvedValue([result({ status: 'success' })]);

            await service.tick();

            expect(sendUnraidNotification).not.toHaveBeenCalled();
        });

        it('announces "schedules executed" whenever anything ran', async () => {
            runDue.mockResolvedValue([result({ status: 'success' })]);

            await service.tick();

            expect(events.publish).toHaveBeenCalledWith('schedules', 'executed');
        });

        it('announces nothing when nothing was due', async () => {
            runDue.mockResolvedValue([]);

            await service.tick();

            expect(events.publish).not.toHaveBeenCalled();
        });

        it('reports a warning notification if runDue itself throws', async () => {
            runDue.mockRejectedValue(new Error('database is locked'));

            await service.tick();

            expect(sendUnraidNotification).toHaveBeenCalledWith(
                expect.objectContaining({ subject: 'Schedule runner failed' }),
                'warning'
            );
        });
    });

    describe('runnerState', () => {
        it('reports stale when the heartbeat file has never been written', () => {
            vi.mocked(statSync).mockImplementation(() => {
                throw new Error('ENOENT');
            });

            const state = service.runnerState(1_800_000_000);

            expect(state).toEqual({
                last_tick: null,
                stale: true,
                stale_after: SCHEDULER_TICK_STALE_SECONDS,
                cron_installed: true,
repaired: false,
            });
        });

        it('reports fresh when the heartbeat is inside the stale window', () => {
            const now = 1_800_000_000;
            vi.mocked(statSync).mockReturnValue({
                mtimeMs: (now - 100) * 1000,
            } as unknown as ReturnType<typeof statSync>);

            expect(service.runnerState(now).stale).toBe(false);
            expect(service.runnerState(now).last_tick).toBe(now - 100);
        });

        it('reports stale once the heartbeat is older than the stale window', () => {
            const now = 1_800_000_000;
            vi.mocked(statSync).mockReturnValue({
                mtimeMs: (now - SCHEDULER_TICK_STALE_SECONDS - 1) * 1000,
            } as unknown as ReturnType<typeof statSync>);

            expect(service.runnerState(now).stale).toBe(true);
        });
    });
});
