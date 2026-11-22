/**
 * Retry for image pulls that a registry rate limits (HTTP 429). Port of
 * `include/pullRateLimit.php`; keep the two in step.
 *
 * A pull goes through the Docker daemon, which reports a 429 as error text
 * ("toomanyrequests: You have reached your pull rate limit ...") and does not
 * pass on the Retry-After header. So the wait is read from the text when the
 * text names one, and is a bounded backoff otherwise. `parseRetryAfter` reads
 * both header forms for a caller that does see the header.
 */

/** Counts the first try: 4 means up to 3 retries. */
export const PULL_RATE_LIMIT_MAX_ATTEMPTS = 4;
export const PULL_RATE_LIMIT_MAX_WAIT_SECONDS = 300;
export const PULL_RATE_LIMIT_BASE_WAIT_SECONDS = 30;

export function isRateLimitMessage(message: string): boolean {
    return /toomanyrequests|too many requests|rate limit|\b429\b/i.test(message);
}

/** Seconds from a Retry-After value (seconds or HTTP-date); null if not understood. */
export function parseRetryAfter(value: string, nowMs: number = Date.now()): number | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const time = Date.parse(trimmed);
    if (Number.isNaN(time)) return null;
    return Math.max(0, Math.ceil((time - nowMs) / 1000));
}

/**
 * Seconds to wait, capped. A "retry after 45" in the message wins; otherwise
 * 30s, 60s, 120s... by attempt number (1 for the first failure).
 */
export function pullRateLimitDelay(message: string, attempt: number): number {
    const named = /retry[- ]after:?\s*(\d+)/i.exec(message);
    const seconds = named
        ? Number(named[1])
        : PULL_RATE_LIMIT_BASE_WAIT_SECONDS * 2 ** Math.max(0, attempt - 1);
    return Math.max(1, Math.min(PULL_RATE_LIMIT_MAX_WAIT_SECONDS, seconds));
}

export interface PullRateLimitHooks {
    /** Shows "retrying in Ns" in the pull's progress stream. */
    notify: (status: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/** When the shared wait ends, in ms. One rate limit usually hits the rest of a batch too. */
let sharedDeadlineMs = 0;

/** For tests. */
export function resetPullRateLimitState(): void {
    sharedDeadlineMs = 0;
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

    const wait = async (seconds: number, label: string): Promise<void> => {
        hooks.notify(`${label}, retrying in ${seconds}s`);
        await sleep(seconds * 1000);
    };

    let error: string | null = null;
    for (let attemptNo = 1; attemptNo <= PULL_RATE_LIMIT_MAX_ATTEMPTS; attemptNo++) {
        const left = Math.ceil((sharedDeadlineMs - now()) / 1000);
        if (left > 0) {
            await wait(Math.min(left, PULL_RATE_LIMIT_MAX_WAIT_SECONDS), 'Waiting for a registry rate limit');
        }

        const last = attemptNo === PULL_RATE_LIMIT_MAX_ATTEMPTS;
        error = await attempt(!last);
        if (error === null || last || !isRateLimitMessage(error)) return error;

        sharedDeadlineMs = Math.max(sharedDeadlineMs, now() + pullRateLimitDelay(error, attemptNo) * 1000);
        await wait(Math.max(1, Math.ceil((sharedDeadlineMs - now()) / 1000)), 'Rate limited by the registry');
    }
    return error;
}
