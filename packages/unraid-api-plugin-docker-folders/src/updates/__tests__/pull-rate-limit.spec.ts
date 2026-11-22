import { beforeEach, describe, expect, it } from 'vitest';

import {
    PULL_RATE_LIMIT_MAX_ATTEMPTS,
    imageRegistry,
    isRateLimitMessage,
    parseRetryAfter,
    pullRateLimitDelay,
    resetPullRateLimitState,
    runWithPullRateLimitRetry,
} from '../pull-rate-limit.js';

const LIMIT = 'toomanyrequests: You have reached your pull rate limit';

function harness() {
    let clock = 1_000_000;
    const slept: number[] = [];
    const notes: string[] = [];
    return {
        slept,
        notes,
        hooks: {
            notify: (s: string) => notes.push(s),
            sleep: async (ms: number) => {
                slept.push(ms / 1000);
                clock += ms;
            },
            now: () => clock,
        },
    };
}

describe('pull rate limit', () => {
    beforeEach(() => resetPullRateLimitState());

    it('recognises rate limit text only', () => {
        expect(isRateLimitMessage(LIMIT)).toBe(true);
        expect(isRateLimitMessage('Too Many Requests')).toBe(true);
        expect(isRateLimitMessage('manifest unknown')).toBe(false);
        expect(isRateLimitMessage('manifest for app:v1.429 not found')).toBe(false);
    });

    it('splits the registry host from an image reference', () => {
        expect(imageRegistry('nginx:latest')).toBe('docker.io');
        expect(imageRegistry('library/nginx')).toBe('docker.io');
        expect(imageRegistry('ghcr.io/foo/bar:1')).toBe('ghcr.io');
        expect(imageRegistry('localhost:5000/app')).toBe('localhost:5000');
    });

    it('does not make a pull from another registry wait', async () => {
        const h = harness();
        const results = [LIMIT, null];
        await runWithPullRateLimitRetry(async () => results.shift() ?? null, h.hooks);
        const other = harness();
        await runWithPullRateLimitRetry(async () => null, { ...other.hooks, registry: 'ghcr.io' });
        expect(other.slept).toEqual([]);
    });

    it('reads Retry-After seconds and HTTP dates', () => {
        expect(parseRetryAfter('45')).toBe(45);
        expect(parseRetryAfter('Thu, 01 Jan 1970 00:17:40 GMT', 1_000_000)).toBe(60);
        expect(parseRetryAfter('soon')).toBeNull();
        expect(parseRetryAfter('')).toBeNull();
    });

    it('uses the message, then backoff, capped', () => {
        expect(pullRateLimitDelay('Retry-After: 45', 1)).toBe(45);
        expect(pullRateLimitDelay(LIMIT, 1)).toBe(30);
        expect(pullRateLimitDelay(LIMIT, 3)).toBe(120);
        expect(pullRateLimitDelay(LIMIT, 6)).toBe(300);
        expect(pullRateLimitDelay('retry after 9999', 1)).toBe(300);
    });

    it('retries after a rate limit and reports it', async () => {
        const h = harness();
        const results = [LIMIT, null];
        const out = await runWithPullRateLimitRetry(async () => results.shift() ?? null, h.hooks);
        expect(out).toBeNull();
        expect(h.slept).toEqual([30]);
        expect(h.notes[0]).toContain('retrying in 30s');
    });

    it('gives up after the attempt cap', async () => {
        const h = harness();
        const out = await runWithPullRateLimitRetry(async () => LIMIT, h.hooks);
        expect(out).toBe(LIMIT);
        expect(h.slept).toHaveLength(PULL_RATE_LIMIT_MAX_ATTEMPTS - 1);
    });

    it('does not retry other errors', async () => {
        const h = harness();
        const out = await runWithPullRateLimitRetry(async () => 'manifest unknown', h.hooks);
        expect(out).toBe('manifest unknown');
        expect(h.slept).toEqual([]);
    });

    it('a pull that starts inside the shared wait waits for it instead of failing', async () => {
        const first = harness();
        // Pull A is rate limited once, then succeeds. It sets the shared deadline.
        const a = [LIMIT, null];
        await runWithPullRateLimitRetry(async () => a.shift() ?? null, first.hooks);
        expect(first.slept).toEqual([30]);

        // Pull B starts at a clock that is 10s before the deadline A set.
        let clock = 1_000_000 + 20_000;
        const slept: number[] = [];
        const out = await runWithPullRateLimitRetry(async () => null, {
            notify: () => {},
            sleep: async (ms) => {
                slept.push(ms / 1000);
                clock += ms;
            },
            now: () => clock,
        });
        expect(out).toBeNull();
        expect(slept).toEqual([10]);
    });
});
