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
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;

/**
 * Recreating a container on two networks. Docker before API 1.44 takes one
 * endpoint at create, and inspect gives `IPAMConfig: {}` for a network added
 * with `docker network connect`, which PHP re-encodes as `[]`.
 */
final class DockerClientRecreateNetworksTest extends TestCase
{
    /** Inspect JSON as Docker returns it, decoded the way DockerClient decodes. */
    private static function inspect(string $mode = 'app_net'): array
    {
        $json = <<<'JSON'
{
  "Config": {"Labels": {}, "ExposedPorts": {"80/tcp": {}}, "Volumes": {}},
  "HostConfig": {
    "NetworkMode": "__MODE__",
    "Sysctls": {}, "Tmpfs": {}, "PortBindings": {},
    "LogConfig": {"Type": "json-file", "Config": {}},
    "Mounts": [{"Type": "volume", "VolumeOptions": {"Labels": {}, "DriverConfig": {"Options": {}}}}]
  },
  "NetworkSettings": {"Networks": {
    "bridge": {"IPAMConfig": null, "Aliases": null, "Links": null, "DriverOpts": null, "IPAddress": "172.17.0.2"},
    "app_net": {"IPAMConfig": {"IPv4Address": "10.9.0.5"}, "Aliases": ["app", "abc123"], "Links": null, "DriverOpts": null},
    "extra_net": {"IPAMConfig": {}, "Aliases": ["abc123"], "Links": null, "DriverOpts": {}}
  }}
}
JSON;
        return json_decode(str_replace('__MODE__', $mode, $json), true);
    }

    #[Test]
    public function primaryIsTheNetworkModeNetwork(): void
    {
        $plan = DockerClient::planNetworks(self::inspect('app_net'));
        $this->assertSame('app_net', $plan['primary']);
        $this->assertSame(['bridge', 'app_net', 'extra_net'], array_keys($plan['endpoints']));
    }

    #[Test]
    public function primaryFallsBackToTheFirstNetwork(): void
    {
        $this->assertSame('bridge', DockerClient::planNetworks(self::inspect('host'))['primary']);
        $this->assertSame('bridge', DockerClient::planNetworks(self::inspect('default'))['primary']);
    }

    #[Test]
    public function noNetworksGivesNoPrimary(): void
    {
        $plan = DockerClient::planNetworks(['NetworkSettings' => ['Networks' => []]]);
        $this->assertNull($plan['primary']);
        $this->assertSame([], $plan['endpoints']);
    }

    #[Test]
    public function emptyIpamConfigEncodesAsAnEmptyEndpointObject(): void
    {
        $plan = DockerClient::planNetworks(self::inspect());
        $this->assertSame('{"Aliases":["abc123"]}', json_encode($plan['endpoints']['extra_net']));
        $this->assertSame('{}', json_encode($plan['endpoints']['bridge']));
        $this->assertSame(
            '{"IPAMConfig":{"IPv4Address":"10.9.0.5"},"Aliases":["app","abc123"]}',
            json_encode($plan['endpoints']['app_net'])
        );
        $this->assertStringNotContainsString('[]', json_encode($plan['endpoints']));
    }

    #[Test]
    public function emptyMapsEncodeAsObjects(): void
    {
        $inspect = self::inspect();
        $body = $inspect['Config'];
        $body['HostConfig'] = $inspect['HostConfig'];
        $json = json_encode(DockerClient::emptyMapsToObjects($body), JSON_UNESCAPED_SLASHES);

        $this->assertStringContainsString('"Labels":{}', $json);
        $this->assertStringContainsString('"Volumes":{}', $json);
        $this->assertStringContainsString('"80/tcp":{}', $json);
        $this->assertStringContainsString('"Sysctls":{}', $json);
        $this->assertStringContainsString('"Tmpfs":{}', $json);
        $this->assertStringContainsString('"PortBindings":{}', $json);
        $this->assertStringContainsString('"LogConfig":{"Type":"json-file","Config":{}}', $json);
        $this->assertStringContainsString('"VolumeOptions":{"Labels":{},"DriverConfig":{"Options":{}}}', $json);
    }

    #[Test]
    public function gpuDeviceRequestOptionsEncodeAsObject(): void
    {
        $body = json_decode(
            '{"HostConfig":{"DeviceRequests":[{"Driver":"","Count":-1,"Capabilities":[["gpu"]],"Options":{}}]}}',
            true
        );
        $json = json_encode(DockerClient::emptyMapsToObjects($body));
        $this->assertStringContainsString('"Options":{}', $json);
        $this->assertStringContainsString('"Capabilities":[["gpu"]]', $json);
    }

    #[Test]
    public function emptyListsStayListsWhileEmptyMapsBecomeObjects(): void
    {
        $body = json_decode(
            '{"Cmd":[],"Entrypoint":[],"Env":[],"Labels":{},"ExposedPorts":{},'
            . '"Healthcheck":{"Test":[]},'
            . '"HostConfig":{"Binds":[],"Dns":[],"DnsSearch":[],"ExtraHosts":[],"CapAdd":[],"Devices":[],"Sysctls":{}}}',
            true
        );
        $json = json_encode(DockerClient::emptyMapsToObjects($body));

        foreach (['"Cmd":[]', '"Entrypoint":[]', '"Env":[]', '"Test":[]', '"Binds":[]', '"Dns":[]',
                  '"DnsSearch":[]', '"ExtraHosts":[]', '"CapAdd":[]', '"Devices":[]'] as $list) {
            $this->assertStringContainsString($list, $json);
        }
        foreach (['"Labels":{}', '"ExposedPorts":{}', '"Sysctls":{}'] as $map) {
            $this->assertStringContainsString($map, $json);
        }
    }

    #[Test]
    public function populatedMapsAndListValuesStayAsTheyAre(): void
    {
        $body = [
            'Labels' => ['a' => 'b'],
            'HostConfig' => ['PortBindings' => ['80/tcp' => [['HostPort' => '8080']], '81/tcp' => []]],
        ];
        $json = json_encode(DockerClient::emptyMapsToObjects($body), JSON_UNESCAPED_SLASHES);
        $this->assertStringContainsString('"Labels":{"a":"b"}', $json);
        $this->assertStringContainsString('"81/tcp":[]', $json);
    }

    public static function macCases(): array
    {
        $cases = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/recreate/macs.json'), true);
        $out = [];
        foreach ($cases as $case) {
            $out[$case['name']] = [$case];
        }
        return $out;
    }

    /** Same fixtures as the plugin's recreate-fixtures.spec.ts: both keep the same MACs. */
    #[Test]
    #[DataProvider('macCases')]
    public function keepsEveryEndpointMacFromApi144(array $case): void
    {
        $plan = DockerClient::planNetworks($case['inspect'], true);
        $macs = [];
        foreach ($plan['endpoints'] as $name => $endpoint) {
            $macs[$name] = ((array) $endpoint)['MacAddress'] ?? null;
        }
        $this->assertSame($case['macs'], $macs);
    }

    #[Test]
    public function sendsNoEndpointMacBeforeApi144(): void
    {
        $inspect = self::inspect();
        $inspect['NetworkSettings']['Networks']['bridge']['MacAddress'] = '02:42:ac:11:00:02';
        $plan = DockerClient::planNetworks($inspect, false);
        foreach ($plan['endpoints'] as $endpoint) {
            $this->assertArrayNotHasKey('MacAddress', (array) $endpoint);
        }
    }

    #[Test]
    public function configMacIsDroppedOnlyWhenEndpointsCarryTheMacs(): void
    {
        $inspect = ['Config' => ['Image' => 'a', 'MacAddress' => 'aa:bb:cc:dd:ee:01'], 'HostConfig' => []];
        $old = DockerClient::buildRecreateBody($inspect, null, null, 'a');
        $new = DockerClient::buildRecreateBody($inspect, null, null, 'a', true);
        $this->assertSame('aa:bb:cc:dd:ee:01', $old['MacAddress']);
        $this->assertArrayNotHasKey('MacAddress', $new);
    }

    #[Test]
    public function endpointMacsNeedApi144(): void
    {
        $this->assertTrue(DockerClient::endpointMacsSupported('1.44'));
        $this->assertTrue(DockerClient::endpointMacsSupported('1.52'));
        $this->assertTrue(DockerClient::endpointMacsSupported('v1.100'));
        $this->assertFalse(DockerClient::endpointMacsSupported('1.43'));
        $this->assertFalse(DockerClient::endpointMacsSupported('1.41'));
        $this->assertFalse(DockerClient::endpointMacsSupported(''));
        $this->assertFalse(DockerClient::endpointMacsSupported(null));
    }
}
