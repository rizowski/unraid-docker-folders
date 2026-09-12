<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * ScheduleManager::resolveContainerMethod is public static specifically so it
 * can be exercised without constructing ScheduleManager, which requires a
 * live Database::getInstance(). These tests are the coverage for issue #7
 * part B: a Start schedule resuming a paused container instead of asking
 * Docker to start an already-running one, and the new Resume action.
 */
final class ScheduleActionTest extends TestCase
{
    #[Test]
    #[DataProvider('methodCases')]
    public function resolvesToTheExpectedDockerClientMethod(string $action, string $state, ?string $expected): void
    {
        $this->assertSame($expected, ScheduleManager::resolveContainerMethod($action, $state));
    }

    public static function methodCases(): array
    {
        return [
            // 'start' on a paused container unpauses instead of starting —
            // the entire point of the fix, since Docker 304s a start on an
            // already-alive (paused) container without resuming it.
            'start while paused resumes' => ['start', 'paused', 'unpauseContainer'],
            'start while running is a normal start' => ['start', 'running', 'startContainer'],
            'start while exited is a normal start' => ['start', 'exited', 'startContainer'],
            // 'resume' always maps to unpauseContainer regardless of state;
            // the no-op-when-not-paused guard lives in executeContainerAction,
            // not in this resolver.
            'resume while exited still resolves to unpause' => ['resume', 'exited', 'unpauseContainer'],
            'resume while paused resolves to unpause' => ['resume', 'paused', 'unpauseContainer'],
            'stop maps to stopContainer' => ['stop', 'running', 'stopContainer'],
            'pause maps to pauseContainer' => ['pause', 'running', 'pauseContainer'],
            'restart maps to restartContainer' => ['restart', 'running', 'restartContainer'],
            'unknown action resolves to null' => ['bogus', 'running', null],
        ];
    }
}
