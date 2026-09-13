<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * ScheduleManager::resolveContainerMethod is public static specifically so it
 * can be exercised without constructing ScheduleManager, which requires a
 * live Database::getInstance(). The paused-start rule itself lives in
 * DockerClient::startContainer, so the resolver only maps action names.
 */
final class ScheduleActionTest extends TestCase
{
    #[Test]
    #[DataProvider('methodCases')]
    public function resolvesToTheExpectedDockerClientMethod(string $action, ?string $expected): void
    {
        $this->assertSame($expected, ScheduleManager::resolveContainerMethod($action));
    }

    public static function methodCases(): array
    {
        return [
            'start maps to startContainer' => ['start', 'startContainer'],
            'resume maps to unpauseContainer' => ['resume', 'unpauseContainer'],
            'stop maps to stopContainer' => ['stop', 'stopContainer'],
            'pause maps to pauseContainer' => ['pause', 'pauseContainer'],
            'restart maps to restartContainer' => ['restart', 'restartContainer'],
            'unknown action resolves to null' => ['bogus', null],
        ];
    }
}
