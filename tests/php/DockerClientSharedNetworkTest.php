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
 * Docker refuses a create body that has ExposedPorts and a
 * `container:<id>` network mode (issue #43).
 */
final class DockerClientSharedNetworkTest extends TestCase
{
    private static function body(string $mode): array
    {
        return [
            'Image' => 'app:latest',
            'ExposedPorts' => ['8080/tcp' => (object) []],
            'HostConfig' => ['NetworkMode' => $mode],
        ];
    }

    #[Test]
    public function dropsExposedPortsForContainerNetworkMode(): void
    {
        $out = DockerClient::dropExposedPortsForSharedNetwork(self::body('container:abc123'));
        $this->assertArrayNotHasKey('ExposedPorts', $out);
        $this->assertSame('app:latest', $out['Image']);
    }

    #[Test]
    public function keepsExposedPortsForOtherModes(): void
    {
        foreach (['bridge', 'host', 'br0', ''] as $mode) {
            $out = DockerClient::dropExposedPortsForSharedNetwork(self::body($mode));
            $this->assertArrayHasKey('ExposedPorts', $out, $mode);
        }
    }
}
