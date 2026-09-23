<?php

declare(strict_types=1);

if (!defined('DOCKER_SOCKET')) {
    define('DOCKER_SOCKET', '/var/run/docker.sock');
}
if (!defined('DOCKER_API_VERSION')) {
    define('DOCKER_API_VERSION', 'v1.41');
}

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * DockerClient::formatLogStream shows Docker's UTC line stamps in the server
 * zone, the PHP default that config.php sets. A line with its own local
 * timestamp loses Docker's stamp, so a UTC stamp beside it would make the
 * pane jump between two clocks.
 */
final class DockerClientLogsTest extends TestCase
{
    private string $previousZone;

    protected function setUp(): void
    {
        $this->previousZone = date_default_timezone_get();
    }

    protected function tearDown(): void
    {
        date_default_timezone_set($this->previousZone);
    }

    private function format(string $raw): string
    {
        $m = new ReflectionMethod(DockerClient::class, 'formatLogStream');
        $m->setAccessible(true);
        return $m->invoke(new DockerClient(), $raw);
    }

    private const RAW = "2026-09-09T05:29:29.100000000Z [info] Attempting to start Privoxy...\n"
        . "2026-09-09T05:29:30.200000000Z 2026-09-08 23:29:30,822 DEBG watchdog output\n"
        . "2026-09-09T05:29:30.300000000Z [info] Privoxy process started\n";

    #[Test]
    public function showsDockerStampsInTheServerZoneNewestFirst(): void
    {
        date_default_timezone_set('America/Denver');
        $this->assertSame(
            "2026-09-08 23:29:30 [info] Privoxy process started\n"
            . "2026-09-08 23:29:30,822 DEBG watchdog output\n"
            . "2026-09-08 23:29:29 [info] Attempting to start Privoxy...",
            $this->format(self::RAW)
        );
    }

    #[Test]
    public function keepsUtcWhenTheServerIsUtc(): void
    {
        date_default_timezone_set('UTC');
        $lines = explode("\n", $this->format(self::RAW));
        $this->assertSame('2026-09-09 05:29:29 [info] Attempting to start Privoxy...', $lines[2]);
    }

    #[Test]
    public function convertsOnlyTheStampAtTheStartOfTheLine(): void
    {
        date_default_timezone_set('America/Denver');
        $this->assertSame(
            '2026-09-08 23:29:29 build 2026-09-09 05:00:00',
            $this->format("2026-09-09T05:29:29.1Z build 2026-09-09T05:00:00.5Z\n")
        );
    }
}
