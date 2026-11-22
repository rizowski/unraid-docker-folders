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
    }

    #[Test]
    public function retryAfterReadsSecondsAndHttpDates(): void
    {
        $this->assertSame(45, parseRetryAfter('45'));
        $this->assertSame(60, parseRetryAfter('Thu, 01 Jan 1970 00:17:40 GMT', 1000));
        $this->assertSame(0, parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1000));
        $this->assertNull(parseRetryAfter('soon'));
        $this->assertNull(parseRetryAfter(''));
    }

    #[Test]
    public function delayUsesTheMessageThenBackoffAndIsCapped(): void
    {
        $this->assertSame(45, dfmPullRateLimitDelay('rate limited, Retry-After: 45', 1));
        $this->assertSame(30, dfmPullRateLimitDelay('toomanyrequests', 1));
        $this->assertSame(120, dfmPullRateLimitDelay('toomanyrequests', 3));
        $this->assertSame(300, dfmPullRateLimitDelay('toomanyrequests', 6));
        $this->assertSame(300, dfmPullRateLimitDelay('retry after 9999', 1));
    }

    #[Test]
    public function retriesAfterARateLimitAndReportsProgress(): void
    {
        $this->assertTrue($this->run429([false, true]));
        $this->assertSame([30], $this->slept);
        $this->assertStringContainsString('retrying in 30s', $this->events[0]['status']);
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
