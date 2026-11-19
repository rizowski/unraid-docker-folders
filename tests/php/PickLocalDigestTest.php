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
 * An image that was re-pulled can carry more than one RepoDigest, and nothing
 * guarantees the current one comes first. The update check must compare the one the registry
 * reports, or the image shows "update available" until the extra digest goes.
 */
final class PickLocalDigestTest extends TestCase
{
    #[Test]
    public function picksTheDigestThatMatchesTheRegistryEvenWhenItIsNotFirst(): void
    {
        $digests = ['postgres@sha256:aaa-old-index', 'postgres@sha256:zzz-current'];
        $this->assertSame('postgres@sha256:zzz-current', DockerClient::pickLocalDigest($digests, 'sha256:zzz-current'));
    }

    #[Test]
    public function fallsBackToTheFirstWhenNoneMatchSoARealUpdateStillShows(): void
    {
        $digests = ['postgres@sha256:one', 'postgres@sha256:two'];
        $this->assertSame('postgres@sha256:one', DockerClient::pickLocalDigest($digests, 'sha256:new'));
    }

    #[Test]
    public function fallsBackToTheFirstWhenThereIsNoRegistryDigest(): void
    {
        $this->assertSame('postgres@sha256:one', DockerClient::pickLocalDigest(['postgres@sha256:one'], null));
    }

    #[Test]
    public function returnsNullForAnImageWithNoRepoDigests(): void
    {
        $this->assertNull(DockerClient::pickLocalDigest([], 'sha256:new'));
    }

    #[Test]
    public function doesNotMatchOnAPrefixOfTheHash(): void
    {
        $this->assertSame('postgres@sha256:abcdef', DockerClient::pickLocalDigest(['postgres@sha256:abcdef', 'postgres@sha256:abc'], 'sha256:abcd'));
    }

    #[Test]
    public function matchesOnTheHashAloneWhenTheMatchingEntryNamesAnotherRepository(): void
    {
        $digests = ['library/postgres@sha256:one', 'mirror.example/postgres@sha256:two'];
        $this->assertSame('mirror.example/postgres@sha256:two', DockerClient::pickLocalDigest($digests, 'sha256:two'));
    }

    #[Test]
    public function matchesABareDigestEntryThatHasNoAtSign(): void
    {
        $this->assertSame('sha256:aaa', DockerClient::pickLocalDigest(['postgres@sha256:bbb', 'sha256:aaa'], 'sha256:aaa'));
        $this->assertSame('postgres@sha256:bbb', DockerClient::pickLocalDigest(['sha256:aaa', 'postgres@sha256:bbb'], 'sha256:bbb'));
    }

    #[Test]
    public function fallsBackToTheFirstForAnEmptyRegistryDigest(): void
    {
        $this->assertSame('postgres@sha256:one', DockerClient::pickLocalDigest(['postgres@sha256:one', 'postgres@sha256:two'], ''));
    }

    #[Test]
    public function fallsBackToTheFirstForANullRegistryDigestWithSeveralEntries(): void
    {
        $this->assertSame('postgres@sha256:one', DockerClient::pickLocalDigest(['postgres@sha256:one', 'postgres@sha256:two'], null));
    }
}
