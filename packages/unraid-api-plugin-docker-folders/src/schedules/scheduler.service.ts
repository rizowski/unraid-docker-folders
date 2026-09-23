import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';

import { DOCKER_SOCKET_PATH } from '../containers/docker-client.js';
import { DatabaseService } from '../db/database.service.js';
import { EventBusService } from '../events/event-bus.service.js';
import { nowSeconds } from '../util/time.js';
import {
    buildScheduleFailureNotification,
    buildScheduleSkipNotification,
    sendUnraidNotification,
} from './schedule-notifications.js';
import { UPDATE_CHECK_SCHEDULES, UpdatesService } from '../updates/updates.service.js';
import { computeNextRun } from './cron.js';
import { ScheduleService } from './schedule.service.js';

/**
 * The jobs this runner can own, written into RUNNER_ALIVE_FILE. PHP stands
 * down for a job only when it is named here, so a job added later never makes
 * an older PHP stop, and a job removed here is picked back up by PHP.
 */
export const RUNNER_JOBS = ['schedules', 'update-checks'] as const;

/**
 * The once-a-minute schedule runner, for GraphQL mode. Ported from
 * `scripts/run-schedules.php`, which cron runs every minute in PHP mode.
 *
 * Exactly one of the two may run due schedules, or a schedule fires twice.
 * PHP's flock cannot arbitrate that: it is a BSD advisory lock, which a Node
 * process has no way to take, so it only ever kept PHP from racing itself.
 * The arbiter is `backend_mode` instead. This runner acts only when it is
 * `graphql`, and `run-schedules.php` acts only when it is not, or when the
 * plugin is not answering, so a stopped API never means schedules silently
 * stop.
 *
 * A timer aligned to the minute rather than `@Cron` from @nestjs/schedule.
 * `@Cron` fires only if the host application registered
 * `ScheduleModule.forRoot()`, which is the Unraid API's own wiring and not a
 * contract a plugin can rely on.
 */

/**
 * The PHP side's half of the arbitration, and the proof it is installed.
 *
 * `backend_mode` alone is not enough. The plugin and the PHP files ship in
 * different packages, so for a while a server can have this plugin next to a
 * PHP backend that predates the gate. That PHP runs due schedules whatever the
 * setting says, and if this runner also ran, every schedule would fire twice.
 * So this runner acts only when the installed PHP defines the function that
 * makes it stand down, and otherwise leaves the work to PHP. Version skew
 * then fails safe: schedules run once, from PHP, rather than twice.
 */
const PHP_CONFIG_PATH = '/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
const PHP_GATE_MARKER = 'function dfmPluginRunnerOwns(';

/**
 * How PHP learns this runner is alive, without asking the API.
 *
 * Touched every minute while this runner is able to own schedules. PHP's
 * `dfmPhpOwnsSchedules()` stands down only while it is fresh. It replaced an
 * HTTP probe, which cost PHP up to two seconds a minute and logged two
 * authentication errors in the API log every minute, because cron has no
 * session to probe with.
 */
export const RUNNER_ALIVE_FILE = '/var/run/unraid-docker-folders-modern.graphql-runner';

/** The heartbeat the schedules screen reads to warn about a dead runner. */
export const SCHEDULER_TICK_FILE = '/var/run/unraid-docker-folders-modern.tick';
export const SCHEDULER_TICK_STALE_SECONDS = 300;

export interface RunnerState {
    last_tick: number | null;
    stale: boolean;
    stale_after: number;
    cron_installed: boolean;
    /** Always false: there is no cron line to put back in GraphQL mode. */
    repaired: boolean;
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SchedulerService.name);
    private alignTimer: NodeJS.Timeout | null = null;
    private interval: NodeJS.Timeout | null = null;
    /**
     * In place of PHP's non-blocking flock. A backup can run longer than a
     * minute, and the next tick must not start a second pass over the same
     * due rows while the first is still working through them.
     */
    private running = false;
    /** Update checks run apart from schedules: one can take minutes. */
    private checking = false;

    constructor(
        private readonly schedules: ScheduleService,
        private readonly db: DatabaseService,
        private readonly events: EventBusService,
        private readonly updates: UpdatesService
    ) {}

    onModuleInit(): void {
        // Now, not at the first tick. The first tick lands on the minute, the
        // same second PHP's cron starts, so a heartbeat written then races
        // PHP's read of it and both runners can take that minute's work.
        if (phpStandsDown()) writeAlive(RUNNER_ALIVE_FILE, RUNNER_JOBS);

        // First tick at the top of the next minute, then every minute, so runs
        // land where a user who wrote "0 3 * * *" expects them.
        const untilNextMinute = 60_000 - (Date.now() % 60_000);
        this.alignTimer = setTimeout(() => {
            this.alignTimer = null;
            void this.tick();
            this.interval = setInterval(() => void this.tick(), 60_000);
        }, untilNextMinute);
    }

    onModuleDestroy(): void {
        // A clean shutdown hands the work back at once instead of after the
        // heartbeat goes stale.
        try {
            unlinkSync(RUNNER_ALIVE_FILE);
        } catch {
            // Already gone.
        }
        if (this.alignTimer !== null) clearTimeout(this.alignTimer);
        if (this.interval !== null) clearInterval(this.interval);
        this.alignTimer = null;
        this.interval = null;
    }

    /** Public so the tests can drive one tick without waiting for a minute. */
    async tick(now = nowSeconds()): Promise<void> {
        // Before the mode check, so PHP can see a live runner the moment the
        // setting flips, and only when PHP has the gate that reads it.
        if (!phpStandsDown()) return;
        writeAlive(RUNNER_ALIVE_FILE, RUNNER_JOBS);

        if (!this.ownsBackgroundWork()) return;

        this.maybeCheckForUpdates(now);

        // After the ownership check, unlike PHP, which touches it first. PHP's
        // cron keeps firing in GraphQL mode and keeps touching it, so touching
        // here as well while PHP owns the work would hide a broken PHP cron
        // behind this process's heartbeat.
        touch(SCHEDULER_TICK_FILE);

        if (!existsSync(DOCKER_SOCKET_PATH)) return;
        if (this.running) return;

        this.running = true;
        try {
            const results = await this.schedules.runDue(now);
            if (results.length > 0) this.events.publish('schedules', 'executed');

            // Automatic runs happen with nobody watching, so a failure or a
            // skip is reported. A manual "Run now" shows its result in the UI.
            for (const result of results) {
                if (result.status === 'skipped') {
                    sendUnraidNotification(buildScheduleSkipNotification(result, result.late_by ?? 0), 'normal');
                    continue;
                }
                // A manual run holds the schedule and reports its own result.
                if (result.success || result.status === 'busy') continue;
                sendUnraidNotification(buildScheduleFailureNotification(result, result.message), 'warning');
            }
        } catch (error) {
            this.logger.error(`Schedule runner failed: ${String(error)}`);
            sendUnraidNotification(
                { subject: 'Schedule runner failed', description: String(error) },
                'warning'
            );
        } finally {
            this.running = false;
        }
    }

    /**
     * The image update check, on the schedule the user picked, in place of the
     * cron line CronManager writes for check-updates.php. The same four
     * expressions, so the check lands on the same minute in either mode.
     */
    private maybeCheckForUpdates(now: number): void {
        if (this.checking) return;

        const settings = this.readSettings(['enable_update_checks', 'update_check_schedule']);
        if (settings.enable_update_checks !== '1') return;
        const expr = UPDATE_CHECK_SCHEDULES[settings.update_check_schedule as keyof typeof UPDATE_CHECK_SCHEDULES];
        if (expr === undefined) return;

        // Due when this minute is the first match after the previous minute.
        const minute = now - (now % 60);
        if (computeNextRun(expr, minute - 60) !== minute) return;

        this.checking = true;
        this.updates
            .runScheduledCheck()
            .catch((error: unknown) => this.logger.error(`Update check failed: ${String(error)}`))
            .finally(() => {
                this.checking = false;
            });
    }

    private readSettings(keys: string[]): Record<string, string | undefined> {
        try {
            const rows = this.db.read(
                (db) =>
                    db
                        .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`)
                        .all(...keys) as { key: string; value: string }[]
            );
            return Object.fromEntries(rows.map((row) => [row.key, row.value]));
        } catch {
            return {};
        }
    }

    /**
     * The runner health the schedules screen shows. In GraphQL mode the
     * runner is this process rather than a cron line, so there is no crontab
     * to inspect: while this answers at all, the runner is installed.
     */
    runnerState(now = nowSeconds()): RunnerState {
        let lastTick: number | null = null;
        try {
            lastTick = Math.floor(statSync(SCHEDULER_TICK_FILE).mtimeMs / 1000);
        } catch {
            lastTick = null;
        }
        const fresh = lastTick !== null && now - lastTick <= SCHEDULER_TICK_STALE_SECONDS;
        return {
            last_tick: lastTick,
            stale: !fresh,
            stale_after: SCHEDULER_TICK_STALE_SECONDS,
            cron_installed: true,
            repaired: false,
        };
    }

    /** Read on every tick, so flipping the setting takes effect within a minute. */
    private ownsBackgroundWork(): boolean {
        try {
            const row = this.db.read(
                (db) =>
                    db.prepare("SELECT value FROM settings WHERE key = 'backend_mode'").get() as
                        | { value?: string }
                        | undefined
            );
            return row?.value === 'graphql';
        } catch (error) {
            // An unreadable database is not permission to run. PHP's own
            // fallback treats anything but graphql as its own.
            this.logger.warn(`Could not read backend_mode: ${String(error)}`);
            return false;
        }
    }
}

function phpStandsDown(): boolean {
    try {
        return readFileSync(PHP_CONFIG_PATH, 'utf8').includes(PHP_GATE_MARKER);
    } catch {
        return false;
    }
}

/** Rewritten each minute, which is also what makes its mtime the heartbeat. */
function writeAlive(path: string, jobs: readonly string[]): void {
    try {
        writeFileSync(path, `${jobs.join(' ')}\n`);
    } catch {
        // PHP then sees a stale heartbeat and keeps the work, which is right.
    }
}

function touch(path: string): void {
    try {
        const now = new Date();
        if (existsSync(path)) {
            utimesSync(path, now, now);
        } else {
            closeSync(openSync(path, 'w'));
        }
    } catch {
        // A heartbeat that cannot be written is reported by the UI as stale,
        // which is the right answer for a runner that cannot prove it ran.
    }
}
