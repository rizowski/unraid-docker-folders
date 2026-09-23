import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { ScheduleService, type ScheduleExecutors } from '../schedule.service.js';
import fixture from './php-schedule-sequence.fixture.json' with { type: 'json' };

/**
 * Replays the exact create/update/toggle/bulk sequence recorded in
 * `php-schedule-sequence.fixture.json` through `ScheduleService`, one step at
 * a time, with the system clock pinned to the anchor `scripts/schedule-oracle.php`
 * captured for that step (via PHP's own `time()`, immediately before the
 * matching `ScheduleManager` call). Any resulting row that disagrees with what
 * `ScheduleManager.php` itself produced is a real behavioral divergence, not
 * an expectation written by hand that only proves the port agrees with a
 * second reading of the same code.
 *
 * Regenerate the fixture (only if create/update/toggle/bulkSetEnabled/
 * bulkDelete change in ScheduleManager.php) with:
 *
 *   docker run --rm -v "$(pwd)":/work -w /work php:8.4-cli \
 *     php packages/unraid-api-plugin-docker-folders/scripts/schedule-oracle.php \
 *     > packages/unraid-api-plugin-docker-folders/src/schedules/__tests__/php-schedule-sequence.fixture.json
 *
 * (run from the repo root; never against a real Unraid box - see the header
 * comment in schedule-oracle.php for why). Every row in the fixture is
 * invented for this test; none of it is real server data.
 */

interface FixtureStep {
    step: string;
    anchor: number;
    result: unknown;
    schedules: Record<string, unknown>[];
}

const steps = fixture as FixtureStep[];

function noExecutors(): ScheduleExecutors {
    const fail = () => Promise.reject(new Error('not used by this sequence'));
    return { containerAction: fail, stackAction: fail, backup: fail };
}

function sortKeys(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]));
}

function normalize(rows: Record<string, unknown>[]): unknown {
    return rows.map(sortKeys);
}

/**
 * `computeNextRun` reads local-time components off `Date`, and PHP's cron
 * matcher reads local-time components off `date()`/`mktime()`. The fixture
 * was generated with `date_default_timezone_set('UTC')` pinned in
 * `schedule-oracle.php`, so this side has to run in the same zone or the two
 * `next_run_at` values compare 3am-here against 3am-there.
 */
const FIXTURE_TIMEZONE = 'UTC';

describe("ScheduleService, against ScheduleManager.php's own recorded output", () => {
    let temp: TempDatabase;
    let service: ScheduleService;
    let originalTimezone: string | undefined;

    afterAll(() => {
        vi.useRealTimers();
    });

    beforeEach(() => {
        originalTimezone = process.env.TZ;
        process.env.TZ = FIXTURE_TIMEZONE;
        vi.useFakeTimers({ toFake: ['Date'] });
        temp = createMigratedDatabase();
        const events = { publish: vi.fn() } as unknown as EventBusService;
        service = new ScheduleService(new DatabaseService(temp.path), events, noExecutors());
    });

    afterEach(() => {
        vi.useRealTimers();
        process.env.TZ = originalTimezone;
        temp.cleanup();
    });

    it('covers the sequence the fixture says it does', () => {
        expect(steps.map((s) => s.step)).toEqual([
            'create_A_backup',
            'create_B_restart_disabled',
            'create_C_resume',
            'create_D_to_delete',
            'update_A_name_and_cron',
            'update_B_enable_only',
            'toggle_C_off',
            'bulk_set_enabled',
            'bulk_delete',
            'update_A_backup_config_only',
        ]);
        // Straddling a leap second/minute during generation would make the
        // fixture worthless (see schedule-oracle.php); this is a floor on how
        // much ground it is expected to have already covered.
        expect(steps.length).toBeGreaterThan(5);
    });

    it('answers identically to ScheduleManager.php at every step of the sequence', () => {
        let idA = 0;
        let idB = 0;
        let idC = 0;
        let idD = 0;

        function step(index: number, run: () => unknown): void {
            const fixtureStep = steps[index];
            vi.setSystemTime(fixtureStep.anchor * 1000);
            const result = run();
            const rows = temp.rows('SELECT * FROM schedules ORDER BY id');

            expect({ step: fixtureStep.step, result }).toEqual({ step: fixtureStep.step, result: fixtureStep.result });
            expect(normalize(rows)).toEqual(normalize(fixtureStep.schedules));
        }

        step(0, () => {
            idA = service.create({
                name: 'Nightly backup',
                target_type: 'container',
                target_id: 'plex',
                action: 'backup',
                cron_expression: '0 3 * * *',
                backup_config: '{"paths":["/config"],"quiesce":"stop"}',
            });
            return idA;
        });

        step(1, () => {
            idB = service.create({
                name: 'Weekly restart',
                target_type: 'stack',
                target_id: 'media',
                action: 'restart',
                cron_expression: '0 3 * * 0',
                enabled: false,
            });
            return idB;
        });

        step(2, () => {
            idC = service.create({
                name: 'Resume plex',
                target_type: 'container',
                target_id: 'plex',
                action: 'resume',
                cron_expression: '*/15 * * * *',
                enabled: true,
            });
            return idC;
        });

        step(3, () => {
            idD = service.create({
                name: 'Quick start',
                target_type: 'container',
                target_id: 'sonarr',
                action: 'start',
                cron_expression: '*/5 * * * *',
            });
            return idD;
        });

        step(4, () => service.update(idA, { name: 'Nightly backup v2', cron_expression: '30 2 * * *' }));

        step(5, () => service.update(idB, { enabled: true }));

        step(6, () => service.toggle(idC, false));

        step(7, () =>
            service.bulkSetEnabled([
                { id: idB, enabled: false },
                { id: idC, enabled: true },
                { id: 999_999, enabled: true },
            ])
        );

        step(8, () => service.bulkDelete([idD, 999_999, 0]));

        step(9, () =>
            service.update(idA, {
                backup_config: '{"paths":["/config","/data"],"quiesce":"pause"}',
            })
        );
    });
});
