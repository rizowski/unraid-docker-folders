/**
 * Retry for image pulls that a registry rate limits (HTTP 429). Port of
 * `include/pullRateLimit.php`; keep the two in step.
 *
 * A pull goes through the Docker daemon, which reports a 429 as error text
 * ("toomanyrequests: You have reached your pull rate limit ...") and does not
 * pass on the Retry-After header. Some registries (lscr.io, ghcr.io) put a wait
 * in the text as a Go duration ("retry-after: 102.996µs"); Docker Hub's text
 * has none. The wait is that hint when present, never below a floor that grows
 * with each attempt.
 */

/** Counts the first try: 4 means up to 3 retries. */
export const PULL_RATE_LIMIT_MAX_ATTEMPTS = 4;
const PULL_RATE_LIMIT_MAX_WAIT_SECONDS = 300;
/** Minimum wait before attempts 2, 3 and 4 (the retries). */
const PULL_RATE_LIMIT_FLOORS = [5, 15, 45];

export function isRateLimitMessage(message: string): boolean {
    return /toomanyrequests|too many requests|rate limit|http 429|status:? 429/i.test(message);
}

const DURATION_UNITS: Record<string, number> = {
    h: 3600,
    m: 60,
    s: 1,
    ms: 1e-3,
    us: 1e-6,
    'µs': 1e-6,
    'μs': 1e-6,
    ns: 1e-9,
};

/**
 * Seconds from a retry hint. Three forms: a Go duration such as "102.996µs" or
 * "1m42.5s" (what a registry puts in the 429 text), a bare number of seconds,
 * or an HTTP-date. Null when empty or not understood.
 */
export function parseRetryAfter(value: string, nowMs: number = Date.now()): number | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (/^(?:\d+(?:\.\d+)?(?:ms|us|µs|μs|ns|h|m|s))+$/.test(trimmed)) {
        let total = 0;
        for (const part of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|us|µs|μs|ns|h|m|s)/g)) {
            total += Number(part[1]) * DURATION_UNITS[part[2]];
        }
        return total;
    }
    const time = Date.parse(trimmed);
    if (Number.isNaN(time)) return null;
    return Math.max(0, (time - nowMs) / 1000);
}

const RETRY_HINT =
    /retry[- ]after:?\s*(?:([A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)|(\d[^\s,;]*))/i;

/**
 * Seconds to wait, capped. The larger of the registry's hint (when the message
 * has one) and a floor for the attempt (1 for the first failure). A hint of a
 * few microseconds means "now", but a batch that retries at once hits the
 * per-minute limit again, so the floor still applies.
 */
export function pullRateLimitDelay(message: string, attempt: number): number {
    const floor = PULL_RATE_LIMIT_FLOORS[Math.min(Math.max(attempt, 1), PULL_RATE_LIMIT_FLOORS.length) - 1];
    const m = RETRY_HINT.exec(message);
    const hint = (m ? parseRetryAfter(m[1] ?? m[2]) : null) ?? 0;
    return Math.min(PULL_RATE_LIMIT_MAX_WAIT_SECONDS, Math.ceil(Math.max(hint, floor)));
}

export interface PullRateLimitHooks {
    /** Shows "retrying in Ns" in the pull's progress stream. */
    notify: (status: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Registry host that shares the wait. Defaults to Docker Hub. */
    registry?: string;
}

/** The registry host of an image reference. No host in the name means Docker Hub. */
export function imageRegistry(image: string): string {
    const slash = image.indexOf('/');
    if (slash === -1) return 'docker.io';
    const first = image.slice(0, slash);
    return first.includes('.') || first.includes(':') || first === 'localhost' ? first.toLowerCase() : 'docker.io';
}

/**
 * When the shared wait ends, in ms, per registry. One rate limit usually hits
 * the rest of a batch too, but not pulls from another registry.
 */
const sharedDeadlines = new Map<string, number>();

/** For tests. */
export function resetPullRateLimitState(): void {
    sharedDeadlines.clear();
}

/**
 * Run `attempt` and retry it on a rate limit error. `attempt(hold)` returns
 * the failure text, or null on success. With `hold` true it must not report
 * a rate limit error as the end of the pull, because a retry follows.
 */
export async function runWithPullRateLimitRetry(
    attempt: (hold: boolean) => Promise<string | null>,
    hooks: PullRateLimitHooks
): Promise<string | null> {
    const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = hooks.now ?? Date.now;
    const registry = hooks.registry ?? 'docker.io';

    const wait = async (seconds: number, label: string): Promise<void> => {
        hooks.notify(`${label}, retrying in ${seconds}s`);
        await sleep(seconds * 1000);
    };

    let error: string | null = null;
    for (let attemptNo = 1; attemptNo <= PULL_RATE_LIMIT_MAX_ATTEMPTS; attemptNo++) {
        const left = Math.ceil(((sharedDeadlines.get(registry) ?? 0) - now()) / 1000);
        if (left > 0) {
            await wait(Math.min(left, PULL_RATE_LIMIT_MAX_WAIT_SECONDS), 'Waiting for a registry rate limit');
        }

        const last = attemptNo === PULL_RATE_LIMIT_MAX_ATTEMPTS;
        error = await attempt(!last);
        if (error === null || last || !isRateLimitMessage(error)) return error;

        const deadline = Math.max(
            sharedDeadlines.get(registry) ?? 0,
            now() + pullRateLimitDelay(error, attemptNo) * 1000
        );
        sharedDeadlines.set(registry, deadline);
        await wait(Math.max(1, Math.ceil((deadline - now()) / 1000)), 'Rate limited by the registry');
    }
    return error;
}
