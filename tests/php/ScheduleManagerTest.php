<?php

declare(strict_types=1);

// Load config.php (defines constants + sets the process timezone), then the
// class under test. ScheduleManager's constructor needs a real database, but
// computeNextRun() is public static — never instantiate the class here.
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';

// Re-enable error reporting for test visibility (config.php disables it)
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

final class ScheduleManagerTest extends TestCase
{
    private string $originalTimezone;

    protected function setUp(): void
    {
        $this->originalTimezone = date_default_timezone_get();
        // Schedules are entered in server-local time; exercise a non-UTC
        // zone with a DST transition so bugs in either dimension surface.
        date_default_timezone_set('America/New_York');
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->originalTimezone);
    }

    #[Test]
    public function dailyThreeAmRunsAtLocalWallClockTime(): void
    {
        // 2026-01-10 10:00 America/New_York (EST, UTC-5)
        $after = strtotime('2026-01-10 10:00:00');

        $next = ScheduleManager::computeNextRun('0 3 * * *', $after);

        $this->assertNotNull($next);
        $this->assertSame('03:00', date('H:i', $next));
        $this->assertSame('2026-01-11', date('Y-m-d', $next));
    }

    #[Test]
    public function nextRunDiffersFromUtcByTheZoneOffset(): void
    {
        // Winter date, well away from any DST transition, so the offset is
        // a stable 5 hours (America/New_York is EST = UTC-5 in January).
        $after = strtotime('2026-01-10 10:00:00');

        $nyNext = ScheduleManager::computeNextRun('0 3 * * *', $after);

        date_default_timezone_set('UTC');
        $utcNext = ScheduleManager::computeNextRun('0 3 * * *', $after);
        $utcNextLocalTime = date('H:i', $utcNext);
        date_default_timezone_set('America/New_York');

        $this->assertNotNull($utcNext);
        // Both computations land on "03:00" in their own zone...
        $this->assertSame('03:00', $utcNextLocalTime);
        // ...but those are different instants: NY's 03:00 happens 5 hours
        // later in absolute time than UTC's 03:00, since NY trails UTC.
        $this->assertSame(5 * 3600, $nyNext - $utcNext);
    }

    #[Test]
    public function staysAtLocalThreeAmAcrossTheSpringDstTransition(): void
    {
        // 2026-03-08 is the US DST "spring forward" date (clocks jump from
        // 2:00 AM to 3:00 AM America/New_York). Starting the evening before,
        // while still on standard time (EST, UTC-5).
        $after = strtotime('2026-03-07 20:00:00');

        $next = ScheduleManager::computeNextRun('0 3 * * *', $after);

        $this->assertNotNull($next);
        // The schedule should still land on 03:00 local wall-clock time (now
        // EDT, UTC-4) rather than drifting by the one-hour jump.
        $this->assertSame('2026-03-08 03:00', date('Y-m-d H:i', $next));
    }
    #[Test]
    public function startStepRunsEveryStepFromTheStartValue(): void
    {
        // "0/3" is shorthand for "0-59/3". It used to match minute 0 only,
        // so a schedule saved at 13:48 next ran at 14:00.
        $after = strtotime('2026-01-10 13:48:00');

        $this->assertSame('2026-01-10 13:51', date('Y-m-d H:i', ScheduleManager::computeNextRun('0/3 * * * *', $after)));
        $this->assertSame('2026-01-10 13:55', date('Y-m-d H:i', ScheduleManager::computeNextRun('5/10 * * * *', $after)));
    }

    #[Test]
    public function plainValuesStillMatchOnlyThemselves(): void
    {
        $after = strtotime('2026-01-10 13:48:00');

        $this->assertSame('2026-01-10 14:00', date('Y-m-d H:i', ScheduleManager::computeNextRun('0 * * * *', $after)));
        $this->assertSame('2026-01-10 13:51', date('Y-m-d H:i', ScheduleManager::computeNextRun('*/3 * * * *', $after)));
    }

    #[Test]
    public function failureNotificationNamesTheScheduleAndContainer(): void
    {
        $n = buildScheduleFailureNotification(
            ['name' => 'Nightly restart', 'target_type' => 'container', 'target_id' => 'plex', 'action' => 'restart'],
            "Container 'plex' not found"
        );

        $this->assertSame('Schedule failed: Nightly restart', $n['subject']);
        $this->assertSame("Could not restart container plex: Container 'plex' not found", $n['description']);
    }

    #[Test]
    public function failureNotificationNamesAStack(): void
    {
        $n = buildScheduleFailureNotification(
            ['name' => 'Stop media', 'target_type' => 'stack', 'target_id' => 'media', 'action' => 'stop'],
            'compose down failed'
        );

        $this->assertSame('Could not stop stack media: compose down failed', $n['description']);
    }

    #[Test]
    public function failureNotificationForABackup(): void
    {
        $n = buildScheduleFailureNotification(
            ['name' => 'Weekly backup', 'target_type' => 'container', 'target_id' => 'plex', 'action' => 'backup'],
            'Invalid backup configuration'
        );

        $this->assertSame('Backup failed: Invalid backup configuration', $n['description']);
    }

    #[Test]
    public function failureNotificationFallsBackWhenTextIsMissing(): void
    {
        $n = buildScheduleFailureNotification(
            ['name' => '', 'target_type' => 'container', 'target_id' => 'plex', 'action' => 'start'],
            ''
        );

        $this->assertSame('Schedule failed: unnamed schedule', $n['subject']);
        $this->assertSame('Could not start container plex: Unknown error', $n['description']);
    }
}
