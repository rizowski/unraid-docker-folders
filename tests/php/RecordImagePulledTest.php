<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

// config.php turns error reporting off; keep it visible for the tests.
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

class PulledImageDockerClient extends DockerClient
{
    public ?string $remote = null;
    public ?array $info = null;

    public function __construct()
    {
        // Skip parent, no Docker socket needed
    }

    public function getRemoteImageDigest($imageName)
    {
        return $this->remote;
    }

    public function getImageInfo($imageId)
    {
        return $this->info;
    }
}

class PulledImageDatabase
{
    public array $params = [];

    public function query(string $sql, array $params = []): mixed
    {
        $this->params = $params;
        return true;
    }
}

/**
 * After a pull, PHP must store the same local_digest as the plugin's
 * recordPulled: the RepoDigest equal to the registry's, else the first.
 */
final class RecordImagePulledTest extends TestCase
{
    private function record(?string $remote, ?array $info): array
    {
        $client = new PulledImageDockerClient();
        $client->remote = $remote;
        $client->info = $info;
        $db = new PulledImageDatabase();
        // The update log directory does not exist off a real Unraid box.
        set_error_handler(fn () => true);
        try {
            recordImagePulled($client, $db, 'postgres:16');
        } finally {
            restore_error_handler();
        }
        return $db->params;
    }

    #[Test]
    public function storesTheDigestThatMatchesTheRegistryWhenItIsNotFirst(): void
    {
        $params = $this->record('sha256:two', ['RepoDigests' => ['postgres@sha256:one', 'postgres@sha256:two']]);
        $this->assertSame('postgres@sha256:two', $params[':local']);
        $this->assertSame('sha256:two', $params[':remote']);
    }

    #[Test]
    public function storesTheFirstDigestWhenNoneMatch(): void
    {
        $params = $this->record('sha256:new', ['RepoDigests' => ['postgres@sha256:one', 'postgres@sha256:two']]);
        $this->assertSame('postgres@sha256:one', $params[':local']);
    }

    #[Test]
    public function storesTheFirstDigestWhenTheRegistryAnswersNothing(): void
    {
        $params = $this->record(null, ['RepoDigests' => ['postgres@sha256:one', 'postgres@sha256:two']]);
        $this->assertSame('postgres@sha256:one', $params[':local']);
        $this->assertNull($params[':remote']);
    }

    #[Test]
    public function storesNullForAnImageWithNoRepoDigestsOrNoInfo(): void
    {
        $this->assertNull($this->record('sha256:new', ['RepoDigests' => []])[':local']);
        $this->assertNull($this->record('sha256:new', null)[':local']);
    }
}
