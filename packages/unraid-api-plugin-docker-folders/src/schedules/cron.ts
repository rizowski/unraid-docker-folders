/**
 * The cron matcher, ported from `ScheduleManager.php`.
 *
 * Schedules are not decided by matching an expression against the current
 * minute. Each row carries a `next_run_at` timestamp, the runner selects rows
 * where it has passed, and whichever runner ran the schedule recomputes it.
 * So this function's only job is to answer "when next", and it has to answer
 * exactly what PHP answers, because both backends write that column and a
 * disagreement would move a user's schedule by an hour or a day.
 *
 * `__tests__/cron.spec.ts` checks that against the PHP implementation itself
 * rather than against expectations written by hand.
 *
 * Local time on purpose. PHP calls `date_default_timezone_set()` with the zone
 * from `ident.cfg`, and Unraid points `/etc/localtime` at that same zone, so
 * the API's own process resolves to it too. Measured on Unraid 7.3.2: PHP and
 * node both answer `America/Denver` on a box configured that way. Doing the
 * arithmetic in UTC would put every schedule out by the offset.
 */

/** Cron accepts 7 for Sunday; JavaScript and PHP both use 0. */
const SUNDAY = 0;

/** How far ahead to look before giving up. Matches PHP's 366 days. */
const SEARCH_LIMIT_DAYS = 366;

/**
 * When does this expression next fire, strictly after `after`?
 *
 * Seconds, not milliseconds, because that is what the `next_run_at` column
 * holds. Answers null for an expression that does not have five fields or
 * that never matches.
 */
export function computeNextRun(cronExpr: string, afterSeconds: number): number | null {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minuteField, hourField, domField, monthField, dowField] = parts;

    // Start at the top of the next minute, so an expression never matches the
    // instant it was computed from.
    let t = afterSeconds - (afterSeconds % 60) + 60;
    const limit = t + SEARCH_LIMIT_DAYS * 86400;

    while (t < limit) {
        const at = new Date(t * 1000);

        const month = at.getMonth() + 1;
        if (!fieldMatches(monthField, month)) {
            // The 1st of the next month, at midnight.
            t = startOfDay(at.getFullYear(), month + 1, 1);
            continue;
        }

        const day = at.getDate();
        if (!fieldMatches(domField, day) || !fieldMatches(dowField, at.getDay(), true)) {
            t = startOfDay(at.getFullYear(), month, day + 1);
            continue;
        }

        const hour = at.getHours();
        if (!fieldMatches(hourField, hour)) {
            t = startOfHour(at.getFullYear(), month, day, hour + 1);
            continue;
        }

        if (fieldMatches(minuteField, at.getMinutes())) return t;

        t += 60;
    }

    return null;
}

/**
 * Local-time equivalents of PHP's `mktime`, which accepts out-of-range values
 * and rolls them over. `new Date(y, m, d)` does the same, and both interpret
 * the parts in the local zone, which is what keeps this aligned with PHP
 * across a daylight-saving boundary.
 */
function startOfDay(year: number, month: number, day: number): number {
    return Math.floor(new Date(year, month - 1, day, 0, 0, 0, 0).getTime() / 1000);
}

function startOfHour(year: number, month: number, day: number, hour: number): number {
    return Math.floor(new Date(year, month - 1, day, hour, 0, 0, 0).getTime() / 1000);
}

function fieldMatches(field: string, value: number, isDow = false): boolean {
    return field.split(',').some((segment) => segmentMatches(segment, value, isDow));
}

function segmentMatches(rawSegment: string, value: number, isDow: boolean): boolean {
    let segment = rawSegment;
    let step = 1;

    const slash = segment.indexOf('/');
    if (slash !== -1) {
        step = toInt(segment.slice(slash + 1));
        segment = segment.slice(0, slash);
    }

    if (segment === '*') {
        return step === 1 ? true : value % step === 0;
    }

    const dash = segment.indexOf('-');
    if (dash !== -1) {
        const lo = toInt(segment.slice(0, dash));
        const hi = toInt(segment.slice(dash + 1));
        if (value < lo || value > hi) return false;
        return (value - lo) % step === 0;
    }

    let target = toInt(segment);
    if (isDow && target === 7) target = SUNDAY;

    // `N/S` is shorthand for `N-<field max>/S`: "0/3" in the minute field means
    // 0, 3, 6 ... 57, not minute 0 alone. `value` never exceeds the field's
    // maximum, so the upper bound needs no check.
    if (step !== 1) {
        return value >= target && (value - target) % step === 0;
    }
    return value === target;
}

/** PHP's `(int)` cast: leading digits, or 0. Never NaN. */
function toInt(value: string): number {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Is this a five-field expression the matcher above can run? Ported from
 * `ScheduleManager::validateCronExpression`.
 *
 * Gates every write. A row with an expression the matcher cannot parse gets a
 * null `next_run_at`, and the runner selects `next_run_at <= now`, which a
 * null never satisfies: the schedule would sit enabled in the UI and silently
 * never run.
 */
export function validateCronExpression(expr: string): boolean {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    // Minute, hour, day of month, month, day of week. 0 and 7 are both Sunday.
    const ranges: [number, number][] = [
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 7],
    ];

    return parts.every((field, i) =>
        field.split(',').every((segment) => validSegment(segment, ranges[i][0], ranges[i][1]))
    );
}

function validSegment(rawSegment: string, min: number, max: number): boolean {
    let segment = rawSegment;

    const slash = segment.indexOf('/');
    if (slash !== -1) {
        const step = segment.slice(slash + 1);
        if (!isNumeric(step) || toInt(step) < 1) return false;
        segment = segment.slice(0, slash);
        if (segment === '*') return true;
    }

    if (segment === '*') return true;

    const dash = segment.indexOf('-');
    if (dash !== -1) {
        const lo = segment.slice(0, dash);
        const hi = segment.slice(dash + 1);
        if (!isNumeric(lo) || !isNumeric(hi)) return false;
        const low = toInt(lo);
        const high = toInt(hi);
        return low >= min && high <= max && low <= high;
    }

    if (isNumeric(segment)) {
        const value = toInt(segment);
        return value >= min && value <= max;
    }

    return false;
}

/**
 * PHP's `is_numeric`, for the inputs a cron field can hold. It accepts a
 * leading sign, a decimal point and an exponent, so "1.5" and "1e1" pass there
 * and are then truncated by `(int)`; this accepts the same strings so the two
 * backends agree on which expressions are valid.
 */
function isNumeric(value: string): boolean {
    return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value);
}
