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

    it('reads durations, seconds and HTTP dates', () => {
        expect(parseRetryAfter('45')).toBe(45);
        expect(parseRetryAfter('1m42s')).toBe(102);
        expect(parseRetryAfter('1m42.5s')).toBeCloseTo(102.5, 9);
        expect(parseRetryAfter('102.996µs')).toBeCloseTo(0.000102996, 12);
        expect(parseRetryAfter('250ms')).toBeCloseTo(0.25, 9);
        expect(parseRetryAfter('Thu, 01 Jan 1970 00:17:40 GMT', 1_000_000)).toBe(60);
        expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1_000_000)).toBe(0);
        expect(parseRetryAfter('soon')).toBeNull();
        expect(parseRetryAfter('')).toBeNull();
    });

    it('waits the larger of the hint and the floor, capped', () => {
        expect(pullRateLimitDelay('toomanyrequests: retry-after: 102.996µs, allowed: 44000/minute', 1)).toBe(5);
        expect(pullRateLimitDelay('toomanyrequests: retry-after: 1m42s, allowed: 1/minute', 1)).toBe(102);
        expect(pullRateLimitDelay('retry-after: 102s', 1)).toBe(102);
        expect(pullRateLimitDelay('Retry-After: 45', 1)).toBe(45);
        expect(pullRateLimitDelay('retry-after: 900s', 1)).toBe(300);
        expect(pullRateLimitDelay(LIMIT, 1)).toBe(5);
        expect(pullRateLimitDelay(LIMIT, 2)).toBe(15);
        expect(pullRateLimitDelay(LIMIT, 3)).toBe(45);
        expect(pullRateLimitDelay(LIMIT, 9)).toBe(45);
        expect(pullRateLimitDelay('retry-after: 102.996µs', 2)).toBe(15);
        expect(pullRateLimitDelay('manifest for app:v1.429 not found', 1)).toBe(5);
        expect(pullRateLimitDelay('retry-after: 120s.', 1)).toBe(120);
        expect(pullRateLimitDelay('retry-after: 5min', 1)).toBe(5);
    });

    it('retries after a rate limit and reports it', async () => {
        const h = harness();
        const results = [LIMIT, null];
        const out = await runWithPullRateLimitRetry(async () => results.shift() ?? null, h.hooks);
        expect(out).toBeNull();
        expect(h.slept).toEqual([5]);
        expect(h.notes[0]).toContain('retrying in 5s');
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
        expect(first.slept).toEqual([5]);

        // Pull B starts at a clock that is 3s before the deadline A set.
        let clock = 1_000_000 + 2_000;
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
        expect(slept).toEqual([3]);
    });
});
