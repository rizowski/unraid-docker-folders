<?php

declare(strict_types=1);

// Load config.php (defines constants + checkAllImageUpdates function)
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

// Load DockerClient so MockDockerClient can extend it
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

// Re-enable error reporting for test visibility (config.php disables it)
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

// --- Stub classes --------------------------------------------------------

class MockDockerClient extends DockerClient
{
    public array $containers = [];
    public array $updateResults = [];
    /** @var array<string, \Throwable> */
    public array $throwOn = [];

    public function __construct()
    {
        // Skip parent – avoids needing a real Docker socket
    }

    public function listContainers($all = true): array
    {
        return $this->containers;
    }

    public function checkImageUpdate($imageName, $localImageId): array
    {
        if (isset($this->throwOn[$imageName])) {
            throw $this->throwOn[$imageName];
        }
        return $this->updateResults[$imageName] ?? [
            'update_available' => false,
            'local_digest' => 'sha256:local123',
            'remote_digest' => 'sha256:remote123',
            'error' => null,
        ];
    }
}

class StubDatabase
{
    private array $settings = [];

    public function setExcludePatterns(string $patterns): void
    {
        $this->settings['update_check_exclude'] = $patterns;
    }

    public function fetchOne(string $sql, array $params = []): array|false
    {
        if (str_contains($sql, 'update_check_exclude')) {
            return isset($this->settings['update_check_exclude'])
                ? ['value' => $this->settings['update_check_exclude']]
                : false;
        }
        return false;
    }

    public function query(string $sql, array $params = []): mixed
    {
        return true;
    }

    public function fetchValue(string $sql, array $params = []): mixed
    {
        return 0;
    }
}

// --- Tests ---------------------------------------------------------------

final class UpdateCheckTest extends TestCase
{
    private MockDockerClient $docker;
    private StubDatabase $db;
    /** @var string[] */
    private array $logMessages;

    protected function setUp(): void
    {
        $this->docker = new MockDockerClient();
        $this->db = new StubDatabase();
        $this->logMessages = [];
    }

    private function log(): callable
    {
        return function (string $message): void {
            $this->logMessages[] = $message;
        };
    }

    private function makeContainer(string $image, string $imageId = 'sha256:abc123'): array
    {
        return [
            'id' => md5($image . random_int(0, 999999)),
            'name' => str_replace('/', '-', $image),
            'image' => $image,
            'imageId' => $imageId,
            'state' => 'running',
            'status' => 'Up 2 hours',
        ];
    }

    #[Test]
    public function allContainersUpToDate(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(0, $result['newUpdates']);
        $this->assertSame(2, $result['checked']);
        $this->assertSame(0, $result['errors']);
        $this->assertSame(0, $result['skipped']);
        $this->assertCount(2, $result['results']);
        $this->assertFalse($result['results']['nginx:latest']['update_available']);
        $this->assertFalse($result['results']['redis:7']['update_available']);
    }

    #[Test]
    public function someContainersHaveUpdates(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
        ];
        $this->docker->updateResults['postgres:15'] = [
            'update_available' => true,
            'local_digest' => 'sha256:oldpg',
            'remote_digest' => 'sha256:newpg',
            'error' => null,
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['newUpdates']);
        $this->assertSame(3, $result['checked']);
        $this->assertTrue($result['results']['nginx:latest']['update_available']);
        $this->assertFalse($result['results']['redis:7']['update_available']);
        $this->assertTrue($result['results']['postgres:15']['update_available']);
    }

    #[Test]
    public function excludedImagesSkipped(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];
        $this->db->setExcludePatterns('nginx:latest,postgres:15');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['skipped']);
        $this->assertSame(1, $result['checked']);
        $this->assertArrayNotHasKey('nginx:latest', $result['results']);
        $this->assertArrayHasKey('redis:7', $result['results']);
        $this->assertArrayNotHasKey('postgres:15', $result['results']);
    }

    #[Test]
    public function wildcardExcludePatterns(): void
    {
        $this->docker->containers = [
            $this->makeContainer('linuxserver/plex'),
            $this->makeContainer('linuxserver/sonarr'),
            $this->makeContainer('redis:7'),
        ];
        $this->db->setExcludePatterns('linuxserver/*');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['skipped']);
        $this->assertSame(1, $result['checked']);
        $this->assertArrayNotHasKey('linuxserver/plex', $result['results']);
        $this->assertArrayNotHasKey('linuxserver/sonarr', $result['results']);
        $this->assertArrayHasKey('redis:7', $result['results']);
    }

    #[Test]
    public function errorFromCheckImageUpdate(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => false,
            'local_digest' => 'sha256:abc',
            'remote_digest' => null,
            'error' => 'Registry timeout',
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(1, $result['errors']);
        $this->assertSame(2, $result['checked']);
        $this->assertSame('Registry timeout', $result['results']['nginx:latest']['error']);
        $this->assertNull($result['results']['redis:7']['error']);
    }

    #[Test]
    public function fatalExceptionCaughtAndLoopContinues(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->docker->throwOn['nginx:latest'] = new \RuntimeException('Connection reset');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(1, $result['errors']);
        $this->assertSame(2, $result['checked']);
        // Exception caught and recorded
        $this->assertSame('Connection reset', $result['results']['nginx:latest']['error']);
        $this->assertFalse($result['results']['nginx:latest']['update_available']);
        // Loop continued to next image
        $this->assertArrayHasKey('redis:7', $result['results']);
        $this->assertNull($result['results']['redis:7']['error']);
    }

    #[Test]
    public function noContainersReturnsAllZeros(): void
    {
        $this->docker->containers = [];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(0, $result['checked']);
        $this->assertSame(0, $result['skipped']);
        $this->assertSame(0, $result['errors']);
        $this->assertSame(0, $result['newUpdates']);
        $this->assertEmpty($result['results']);
    }

    #[Test]
    public function duplicateImagesCheckedOnce(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest', 'sha256:same1'),
            $this->makeContainer('nginx:latest', 'sha256:same1'),
            $this->makeContainer('redis:7', 'sha256:redis1'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['checked']);
        $this->assertCount(2, $result['results']);
        $this->assertSame(1, $result['newUpdates']);
    }

    #[Test]
    public function logCallbackReceivesExpectedMessages(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
        ];
        $this->docker->updateResults['redis:7'] = [
            'update_available' => false,
            'local_digest' => 'sha256:local',
            'remote_digest' => 'sha256:remote',
            'error' => 'Timeout',
        ];
        $this->docker->throwOn['postgres:15'] = new \RuntimeException('Socket error');

        checkAllImageUpdates($this->docker, $this->db, $this->log());

        // Collect log prefixes
        $prefixes = array_map(function ($msg) {
            return explode(' ', $msg, 2)[0];
        }, $this->logMessages);

        $this->assertContains('INFO', $prefixes);
        $this->assertContains('UPDATE', $prefixes);
        $this->assertContains('ERROR', $prefixes);
        $this->assertContains('FATAL', $prefixes);

        // Verify image names appear in logs
        $allLogs = implode("\n", $this->logMessages);
        $this->assertStringContainsString('nginx:latest', $allLogs);
        $this->assertStringContainsString('redis:7', $allLogs);
        $this->assertStringContainsString('postgres:15', $allLogs);
        $this->assertStringContainsString('Socket error', $allLogs);
    }
}
