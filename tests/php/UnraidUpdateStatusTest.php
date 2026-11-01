<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/** Answers getImageInfo() from a map, so the repair needs no Docker. */
class ImageInfoDockerClient extends DockerClient
{
    /** @var array<string, array> */
    public array $images = [];
    /** @var string[] */
    public array $asked = [];

    public function __construct()
    {
    }

    public function getImageInfo($imageId)
    {
        $this->asked[] = (string) $imageId;
        return $this->images[$imageId] ?? null;
    }
}

/**
 * Issue #23: a plugin pull must leave Unraid's own update flags current.
 */
final class UnraidUpdateStatusTest extends TestCase
{
    private const D1 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    private const D2 = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

    private string $dir;
    private string $status;
    private string $webui;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/dfm-unraid-status-' . bin2hex(random_bytes(4));
        mkdir($this->dir);
        $this->status = $this->dir . '/unraid-update-status.json';
        $this->webui = $this->dir . '/docker.json';
    }

    protected function tearDown(): void
    {
        foreach (scandir($this->dir) ?: [] as $entry) {
            if (is_file($this->dir . '/' . $entry)) {
                unlink($this->dir . '/' . $entry);
            }
        }
        rmdir($this->dir);
    }

    private function writeJson(string $path, array $data): void
    {
        file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    private function readJson(string $path): array
    {
        return json_decode((string) file_get_contents($path), true);
    }

    #[Test]
    public function keyMatchesUnraidsEnsureImageTag(): void
    {
        $fixture = __DIR__ . '/../../packages/unraid-api-plugin-docker-folders/src/updates/__tests__/unraid-image-keys.fixture.json';
        $cases = json_decode((string) file_get_contents($fixture), true);
        $this->assertNotEmpty($cases);
        foreach ($cases as $case) {
            $this->assertSame($case['key'], unraidImageKey($case['image']), $case['image']);
        }
    }

    #[Test]
    public function keyRefusesIdsAndDigestReferences(): void
    {
        $this->assertNull(unraidImageKey('sha256:' . str_repeat('a', 64)));
        $this->assertNull(unraidImageKey('nginx@' . self::D1));
        $this->assertNull(unraidImageKey(''));
    }

    #[Test]
    public function digestIsBareSha256(): void
    {
        $this->assertSame(self::D1, bareImageDigest(self::D1));
        $this->assertSame(self::D1, bareImageDigest('lscr.io/linuxserver/sonarr@' . self::D1));
        $this->assertNull(bareImageDigest('sha256:abc'));
        $this->assertNull(bareImageDigest(null));
    }

    #[Test]
    public function pullStatusLineGivesTheDigest(): void
    {
        $this->assertSame(self::D1, pullDigestFromStatus('Digest: ' . self::D1));
        $this->assertNull(pullDigestFromStatus('Status: Downloaded newer image for nginx:latest'));
        $this->assertNull(pullDigestFromStatus('Pulling fs layer'));
        $this->assertNull(pullDigestFromStatus(null));
    }

    #[Test]
    public function markWritesUnraidsEntryAndKeepsTheOthers(): void
    {
        $other = ['local' => self::D2, 'remote' => self::D2, 'status' => 'true'];
        $this->writeJson($this->status, [
            'lscr.io/linuxserver/sonarr:latest' => ['local' => self::D2, 'remote' => self::D1, 'status' => 'false'],
            'library/redis:7' => $other,
        ]);

        $this->assertTrue(markUnraidImageCurrent('lscr.io/linuxserver/sonarr', self::D1, [], $this->status, $this->webui));

        $data = $this->readJson($this->status);
        $this->assertSame(
            ['local' => self::D1, 'remote' => self::D1, 'status' => 'true'],
            $data['lscr.io/linuxserver/sonarr:latest']
        );
        $this->assertSame($other, $data['library/redis:7']);
        $this->assertSame([], glob($this->dir . '/.*.tmp') ?: [], 'no temp file left behind');
    }

    #[Test]
    public function markCreatesAMissingFile(): void
    {
        $this->assertTrue(markUnraidImageCurrent('nginx', 'nginx@' . self::D1, [], $this->status, $this->webui));
        $this->assertSame(
            ['library/nginx:latest' => ['local' => self::D1, 'remote' => self::D1, 'status' => 'true']],
            $this->readJson($this->status)
        );
    }

    #[Test]
    public function markLeavesAnUnreadableFileAlone(): void
    {
        foreach (['{"truncated": ', '', '"a string"'] as $content) {
            file_put_contents($this->status, $content);
            $this->assertFalse(markUnraidImageCurrent('nginx', self::D1, [], $this->status, $this->webui));
            $this->assertSame($content, file_get_contents($this->status));
        }
    }

    #[Test]
    public function markWritesNothingWithoutADigest(): void
    {
        $this->assertFalse(markUnraidImageCurrent('nginx', null, ['web'], $this->status, $this->webui));
        $this->assertFalse(markUnraidImageCurrent('nginx', 'sha256:short', ['web'], $this->status, $this->webui));
        $this->assertFileDoesNotExist($this->status);
    }

    #[Test]
    public function markKeepsTheFileMode(): void
    {
        $this->writeJson($this->status, []);
        chmod($this->status, 0600);
        markUnraidImageCurrent('nginx', self::D1, [], $this->status, $this->webui);
        clearstatcache();
        $this->assertSame(0600, fileperms($this->status) & 0777);
    }

    #[Test]
    public function markDropsTheDockerTabCacheForThoseContainers(): void
    {
        $this->writeJson($this->webui, [
            'sonarr' => ['updated' => 'false', 'template' => '/boot/x.xml'],
            'radarr' => ['updated' => 'true', 'template' => '/boot/y.xml'],
        ]);

        markUnraidImageCurrent('lscr.io/linuxserver/sonarr', self::D1, ['sonarr'], $this->status, $this->webui);

        $this->assertSame(['radarr'], array_keys($this->readJson($this->webui)));
    }

    #[Test]
    public function markNeverCreatesTheDockerTabCache(): void
    {
        markUnraidImageCurrent('nginx', self::D1, ['web'], $this->status, $this->webui);
        $this->assertFileDoesNotExist($this->webui);
    }

    #[Test]
    public function containerNamesMatchByUnraidKey(): void
    {
        $containers = [
            ['name' => 'web', 'image' => 'nginx'],
            ['name' => 'web2', 'image' => 'library/nginx:latest'],
            ['name' => 'old', 'image' => 'nginx:1.25'],
            ['name' => 'moved', 'image' => 'sha256:' . str_repeat('b', 64)],
        ];
        $this->assertSame(['web', 'web2'], containerNamesForImage($containers, 'nginx:latest'));
    }

    #[Test]
    public function repairClearsAFlagWhenTheImageOnDiskIsTheRemoteOne(): void
    {
        $this->writeJson($this->status, [
            'lscr.io/linuxserver/sonarr:latest' => ['local' => self::D2, 'remote' => self::D1, 'status' => 'false'],
            // A real update: the image on disk is not the remote one.
            'lscr.io/linuxserver/radarr:latest' => ['local' => self::D2, 'remote' => self::D1, 'status' => 'false'],
            'library/redis:7' => ['local' => self::D2, 'remote' => self::D2, 'status' => 'true'],
        ]);
        $this->writeJson($this->webui, ['sonarr' => ['updated' => 'false'], 'radarr' => ['updated' => 'false']]);

        $client = new ImageInfoDockerClient();
        $client->images['lscr.io/linuxserver/sonarr:latest'] = ['RepoDigests' => ['lscr.io/linuxserver/sonarr@' . self::D1]];
        $client->images['lscr.io/linuxserver/radarr:latest'] = ['RepoDigests' => ['lscr.io/linuxserver/radarr@' . self::D2]];
        $containers = [
            ['name' => 'sonarr', 'image' => 'lscr.io/linuxserver/sonarr'],
            ['name' => 'radarr', 'image' => 'lscr.io/linuxserver/radarr'],
        ];

        $repaired = repairUnraidUpdateStatus($client, $containers, $this->status, $this->webui);

        $this->assertSame(['lscr.io/linuxserver/sonarr:latest'], $repaired);
        $data = $this->readJson($this->status);
        $this->assertSame('true', $data['lscr.io/linuxserver/sonarr:latest']['status']);
        $this->assertSame(self::D1, $data['lscr.io/linuxserver/sonarr:latest']['local']);
        $this->assertSame('false', $data['lscr.io/linuxserver/radarr:latest']['status']);
        $this->assertNotContains('library/redis:7', $client->asked, 'a current entry is not inspected');
        $this->assertSame(['radarr'], array_keys($this->readJson($this->webui)));
    }

    #[Test]
    public function repairWritesNothingWhenNothingIsStale(): void
    {
        $content = json_encode(['library/redis:7' => ['local' => self::D2, 'remote' => self::D2, 'status' => 'true']]);
        file_put_contents($this->status, $content);

        $this->assertSame([], repairUnraidUpdateStatus(new ImageInfoDockerClient(), [], $this->status, $this->webui));
        $this->assertSame($content, file_get_contents($this->status));
    }
}
