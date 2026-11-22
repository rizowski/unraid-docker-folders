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
 * A recreate copies what the user set, not the old image's defaults.
 */
final class DockerClientRecreateUserSettingsTest extends TestCase
{
    private const OLD_ID = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    private const VOL_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    private const VOL_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    private static function imageConfig(): array
    {
        return [
            'Env' => ['PATH=/usr/bin', 'MODE=v1', 'KEEP=same'],
            'Cmd' => ['serve', '--v1'],
            'Entrypoint' => ['/entry-v1'],
            'WorkingDir' => '/v1',
            'User' => 'app',
            'Healthcheck' => ['Test' => ['CMD', 'check-v1']],
            'Labels' => ['org.image' => 'v1', 'shared' => 'a'],
            'ExposedPorts' => ['80/tcp' => []],
            'Volumes' => ['/data' => []],
        ];
    }

    /** The container's Config: image defaults plus user additions. */
    private static function containerConfig(array $override = []): array
    {
        return array_merge(self::imageConfig(), [
            'Hostname' => substr(self::OLD_ID, 0, 12),
            'Tty' => true,
            'Domainname' => 'lan',
        ], $override);
    }

    #[Test]
    public function imageDefaultsAreDropped(): void
    {
        $out = DockerClient::userSettingsConfig(self::containerConfig(), self::imageConfig(), self::OLD_ID);
        foreach (['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck'] as $field) {
            $this->assertArrayNotHasKey($field, $out, $field);
        }
        $this->assertSame([], $out['Env']);
        $this->assertSame([], $out['Labels']);
        $this->assertSame([], $out['ExposedPorts']);
        $this->assertSame([], $out['Volumes']);
        // Other fields stay as today.
        $this->assertTrue($out['Tty']);
        $this->assertSame('lan', $out['Domainname']);
    }

    #[Test]
    public function userOverridesAreKept(): void
    {
        $config = self::containerConfig([
            'Env' => ['PATH=/usr/bin', 'MODE=mine', 'EXTRA=1', 'KEEP=same'],
            'Cmd' => ['serve', '--mine'],
            'WorkingDir' => '/mine',
            'Labels' => ['org.image' => 'v1', 'shared' => 'changed', 'net.unraid.docker.managed' => 'dockerman'],
            'ExposedPorts' => ['80/tcp' => [], '9000/tcp' => []],
            'Volumes' => ['/data' => [], '/extra' => []],
        ]);
        $out = DockerClient::userSettingsConfig($config, self::imageConfig(), self::OLD_ID);

        $this->assertSame(['MODE=mine', 'EXTRA=1'], $out['Env']);
        $this->assertSame(['serve', '--mine'], $out['Cmd']);
        $this->assertSame('/mine', $out['WorkingDir']);
        $this->assertSame(['shared' => 'changed', 'net.unraid.docker.managed' => 'dockerman'], $out['Labels']);
        $this->assertSame(['9000/tcp' => []], $out['ExposedPorts']);
        $this->assertSame(['/extra' => []], $out['Volumes']);
        $this->assertArrayNotHasKey('Entrypoint', $out);
    }

    #[Test]
    public function entrypointOverrideIsKept(): void
    {
        $out = DockerClient::userSettingsConfig(
            self::containerConfig(['Entrypoint' => ['/my-entry'], 'Cmd' => null]),
            self::imageConfig(),
            self::OLD_ID
        );
        $this->assertSame(['/my-entry'], $out['Entrypoint']);
        // Docker clears Cmd with an entrypoint override. That stays.
        $this->assertArrayHasKey('Cmd', $out);
        $this->assertNull($out['Cmd']);
    }

    #[Test]
    public function envEqualToTheImageDefaultIsDroppedKnownGap(): void
    {
        // The user set KEEP=same on purpose, but it equals the old default.
        $out = DockerClient::userSettingsConfig(
            self::containerConfig(['Env' => ['KEEP=same', 'MODE=v1']]),
            self::imageConfig(),
            self::OLD_ID
        );
        $this->assertSame([], $out['Env']);
    }

    #[Test]
    public function hostnameIsDroppedOnlyWhenGenerated(): void
    {
        $generated = DockerClient::userSettingsConfig(self::containerConfig(), self::imageConfig(), self::OLD_ID);
        $this->assertArrayNotHasKey('Hostname', $generated);

        $custom = DockerClient::userSettingsConfig(
            self::containerConfig(['Hostname' => 'my-host']),
            self::imageConfig(),
            self::OLD_ID
        );
        $this->assertSame('my-host', $custom['Hostname']);

        $shared = DockerClient::userSettingsConfig(
            self::containerConfig(['Hostname' => 'my-host']),
            self::imageConfig(),
            self::OLD_ID,
            'container:abc'
        );
        $this->assertArrayNotHasKey('Hostname', $shared);
    }

    #[Test]
    public function failedImageInspectCopiesEverything(): void
    {
        $config = self::containerConfig();
        $out = DockerClient::userSettingsConfig($config, null, self::OLD_ID);
        unset($config['Hostname']);
        $this->assertSame($config, $out);
    }

    #[Test]
    public function anonymousVolumesAreReused(): void
    {
        $inspect = [
            'HostConfig' => ['Binds' => ['/mnt/user/x:/x', 'named_vol:/named'], 'Mounts' => []],
            'Mounts' => [
                ['Type' => 'volume', 'Name' => self::VOL_A, 'Destination' => '/data'],
                ['Type' => 'volume', 'Name' => 'named_vol', 'Destination' => '/named'],
                ['Type' => 'bind', 'Source' => '/mnt/user/x', 'Destination' => '/x'],
                ['Type' => 'volume', 'Name' => self::VOL_B, 'Destination' => '/x'],
            ],
        ];
        $this->assertSame(
            [['Type' => 'volume', 'Source' => self::VOL_A, 'Target' => '/data']],
            DockerClient::reuseAnonymousVolumes($inspect)
        );
    }

    #[Test]
    public function declaredMountWithoutSourceGetsTheOldVolume(): void
    {
        $inspect = [
            'HostConfig' => ['Mounts' => [['Type' => 'volume', 'Target' => '/data']]],
            'Mounts' => [['Type' => 'volume', 'Name' => self::VOL_A, 'Destination' => '/data']],
        ];
        $this->assertEqualsCanonicalizing(
            [['Type' => 'volume', 'Source' => self::VOL_A, 'Target' => '/data']],
            DockerClient::reuseAnonymousVolumes($inspect)
        );
    }

    #[Test]
    public function userNamedHexVolumeIsNotDuplicated(): void
    {
        $inspect = [
            'HostConfig' => ['Mounts' => [['Type' => 'volume', 'Source' => self::VOL_A, 'Target' => '/data']]],
            'Mounts' => [['Type' => 'volume', 'Name' => self::VOL_A, 'Destination' => '/data']],
        ];
        $this->assertCount(1, DockerClient::reuseAnonymousVolumes($inspect));
    }

    #[Test]
    public function noMountsGivesAnEmptyList(): void
    {
        $this->assertSame([], DockerClient::reuseAnonymousVolumes(['HostConfig' => [], 'Mounts' => []]));
    }
}
