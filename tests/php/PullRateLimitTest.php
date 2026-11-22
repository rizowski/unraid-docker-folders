<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/pullRateLimit.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/** Retry of a pull that a registry rate limits (HTTP 429). */
final class PullRateLimitTest extends TestCase
{
    private string $state;
    private int $clock = 1000;
    /** @var int[] */
    private array $slept = [];
    /** @var array[] */
    private array $events = [];

    protected function setUp(): void
    {
        $this->state = tempnam(sys_get_temp_dir(), 'dfm-rl-');
        unlink($this->state);
        $this->clock = 1000;
        $this->slept = [];
        $this->events = [];
    }

    protected function tearDown(): void
    {
        @unlink($this->state);
    }

    private function run429(array $outcomes, string $error = 'toomanyrequests: You have reached your pull rate limit'): bool
    {
        $calls = 0;
        $lastError = '';
        return dfmRunPullWithRateLimitRetry(
            function ($emit, $hold) use (&$calls, &$lastError, $outcomes, $error) {
                $ok = $outcomes[$calls++] ?? false;
                $lastError = $ok ? '' : $error;
                return $ok;
            },
            function () use (&$lastError) { return $lastError; },
            function ($c) { $this->events[] = $c; },
            function ($s) { $this->slept[] = $s; $this->clock += $s; },
            $this->state,
            function () { return $this->clock; }
        );
    }

    #[Test]
    public function recognisesRateLimitText(): void
    {
        $this->assertTrue(dfmIsRateLimitMessage('toomanyrequests: You have reached your pull rate limit.'));
        $this->assertTrue(dfmIsRateLimitMessage('Too Many Requests'));
        $this->assertFalse(dfmIsRateLimitMessage('manifest unknown'));
        $this->assertFalse(dfmIsRateLimitMessage('manifest for app:v1.429 not found'));
    }

    #[Test]
    public function theWaitIsPerRegistry(): void
    {
        $this->assertSame('docker.io', dfmImageRegistry('nginx:latest'));
        $this->assertSame('docker.io', dfmImageRegistry('library/nginx'));
        $this->assertSame('ghcr.io', dfmImageRegistry('ghcr.io/foo/bar:1'));
        $this->assertSame('localhost:5000', dfmImageRegistry('localhost:5000/app'));
        $this->assertNotSame(dfmPullRateLimitStatePath('docker.io'), dfmPullRateLimitStatePath('ghcr.io'));
    }

    #[Test]
    public function retryAfterReadsDurationsSecondsAndHttpDates(): void
    {
        $this->assertSame(45.0, dfmParseRetryAfter('45'));
        $this->assertSame(102.0, dfmParseRetryAfter('1m42s'));
        $this->assertEqualsWithDelta(102.5, dfmParseRetryAfter('1m42.5s'), 1e-9);
        $this->assertEqualsWithDelta(0.000102996, dfmParseRetryAfter('102.996µs'), 1e-12);
        $this->assertEqualsWithDelta(0.25, dfmParseRetryAfter('250ms'), 1e-9);
        $this->assertSame(60.0, dfmParseRetryAfter('Thu, 01 Jan 1970 00:17:40 GMT', 1000));
        $this->assertSame(0.0, dfmParseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1000));
        $this->assertNull(dfmParseRetryAfter('soon'));
        $this->assertNull(dfmParseRetryAfter(''));
    }

    #[Test]
    public function delayIsTheLargerOfTheHintAndTheFloorAndIsCapped(): void
    {
        $this->assertSame(5, dfmPullRateLimitDelay('toomanyrequests: retry-after: 102.996µs, allowed: 44000/minute', 1));
        $this->assertSame(102, dfmPullRateLimitDelay('toomanyrequests: retry-after: 1m42s, allowed: 1/minute', 1));
        $this->assertSame(102, dfmPullRateLimitDelay('retry-after: 102s', 1));
        $this->assertSame(45, dfmPullRateLimitDelay('rate limited, Retry-After: 45', 1));
        $this->assertSame(300, dfmPullRateLimitDelay('retry-after: 900s', 1));
        $this->assertSame(5, dfmPullRateLimitDelay('toomanyrequests: You have reached your pull rate limit.', 1));
        $this->assertSame(15, dfmPullRateLimitDelay('toomanyrequests', 2));
        $this->assertSame(45, dfmPullRateLimitDelay('toomanyrequests', 3));
        $this->assertSame(45, dfmPullRateLimitDelay('toomanyrequests', 9));
        $this->assertSame(15, dfmPullRateLimitDelay('retry-after: 102.996µs', 2));
        $this->assertSame(5, dfmPullRateLimitDelay('manifest for app:v1.429 not found', 1));
        $this->assertSame(120, dfmPullRateLimitDelay('retry-after: 120s.', 1));
        $this->assertSame(5, dfmPullRateLimitDelay('retry-after: 5min', 1));
    }

    #[Test]
    public function retriesAfterARateLimitAndReportsProgress(): void
    {
        $this->assertTrue($this->run429([false, true]));
        $this->assertSame([5], $this->slept);
        $this->assertStringContainsString('retrying in 5s', $this->events[0]['status']);
    }

    #[Test]
    public function givesUpAfterTheAttemptCap(): void
    {
        $this->assertFalse($this->run429([]));
        $this->assertCount(DFM_PULL_RATE_LIMIT_MAX_ATTEMPTS - 1, $this->slept);
    }

    #[Test]
    public function otherErrorsAreNotRetried(): void
    {
        $this->assertFalse($this->run429([], 'manifest unknown'));
        $this->assertSame([], $this->slept);
    }

    #[Test]
    public function aLaterPullWaitsForTheSharedDeadlineInsteadOfFailing(): void
    {
        file_put_contents($this->state, (string) ($this->clock + 50));
        $this->assertTrue($this->run429([true]));
        $this->assertSame([50], $this->slept);
    }
}
