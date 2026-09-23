import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeNextRun, validateCronExpression } from '../cron.js';
import phpValidity from './php-cron-validation.fixture.json' with { type: 'json' };
import phpAnswers from './php-next-run.fixture.json' with { type: 'json' };

/**
 * The fixture holds what `ScheduleManager::computeNextRun` actually answered.
 *
 * It was produced by lifting the three pure static methods out of
 * `ScheduleManager.php` verbatim and running them under PHP on the target
 * server, so this compares against PHP's own code rather than against a second
 * reading of it. Expectations written by hand would only prove the port agrees
 * with whoever wrote them.
 *
 * Both backends write `schedules.next_run_at`, so a disagreement moves a
 * user's backup by an hour or a day depending on which one ran last. The
 * cases deliberately straddle both daylight-saving boundaries in the server's
 * zone, a leap day, and February 29 in a non-leap year.
 *
 * Regenerate with `scripts/cron-oracle.php` if PHP's matcher ever changes.
 *
 * The zone is pinned here rather than in a config file, because it is a
 * property of the fixture and not of the suite: the answers were generated on
 * a server set to America/Denver, and the whole point of the daylight-saving
 * cases is that they only differ in a zone that observes it. Node re-reads
 * `process.env.TZ` per operation, so setting it here is enough.
 */
const FIXTURE_TIMEZONE = 'America/Denver';

describe('computeNextRun', () => {
    let originalTimezone: string | undefined;

    beforeAll(() => {
        originalTimezone = process.env.TZ;
        process.env.TZ = FIXTURE_TIMEZONE;
    });

    afterAll(() => {
        process.env.TZ = originalTimezone;
    });

    it('answers what PHP answers, for every case in the fixture', () => {
        const disagreements = phpAnswers
            .map((answer) => ({ answer, ours: computeNextRun(answer.expr, answer.after) }))
            .filter(({ answer, ours }) => ours !== answer.next)
            .map(({ answer, ours }) => ({
                expr: answer.expr,
                after: new Date(answer.after * 1000).toString(),
                php: answer.next === null ? null : new Date(answer.next * 1000).toString(),
                ours: ours === null ? null : new Date(ours * 1000).toString(),
            }));

        expect(disagreements).toEqual([]);
    });

    it('covers enough ground to be worth trusting', () => {
        expect(phpAnswers.length).toBeGreaterThan(200);
        expect(new Set(phpAnswers.map((a) => a.expr)).size).toBeGreaterThan(15);
    });

    it('refuses an expression that does not have five fields', () => {
        expect(computeNextRun('0 3 * *', 1772103600)).toBeNull();
        expect(computeNextRun('0 3 * * * *', 1772103600)).toBeNull();
        expect(computeNextRun('', 1772103600)).toBeNull();
    });

    // A schedule must not fire again for the minute it was just computed from.
    it('always answers strictly later than the time it was given', () => {
        const at = 1772186400;
        expect(computeNextRun('* * * * *', at)).toBeGreaterThan(at);
    });

    // Cron treats 7 as Sunday; PHP's date('w') and JavaScript's getDay() use 0.
    it('reads day 7 as Sunday, the way cron does', () => {
        const from = 1772103600;
        expect(computeNextRun('0 3 * * 7', from)).toBe(computeNextRun('0 3 * * 0', from));
    });
});

/**
 * What `ScheduleManager::validateCronExpression` answered for each of these,
 * run under PHP on the target server. The cases lean on the edges: out of
 * range fields, reversed ranges, zero and negative steps, the wrong field
 * count, and the inputs PHP's `is_numeric` accepts that a strict parser would
 * not, such as "1.5" and "+5". Validation gates every write, so a string one
 * backend accepts and the other rejects is a schedule that can only be saved
 * in one mode.
 */
describe('validateCronExpression', () => {
    it('accepts and rejects exactly what PHP does', () => {
        const disagreements = phpValidity.filter(
            (c) => validateCronExpression(c.expr) !== c.valid
        );
        expect(disagreements).toEqual([]);
    });

    it('covers both answers', () => {
        expect(phpValidity.some((c) => c.valid)).toBe(true);
        expect(phpValidity.some((c) => !c.valid)).toBe(true);
    });
});
