<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * DockerClient::extractFacts() — the pure transform behind the per-ID facts
 * cache. It takes one `docker inspect` payload and keeps the four things the
 * container list needs, so it is testable with no socket and no database.
 *
 * Field shapes here follow real inspect output: CapAdd comes back as a plain
 * list, ExposedPorts as an object keyed "<port>/<proto>", and PortBindings as
 * an object whose values are lists.
 */
final class ContainerFactsTest extends TestCase
{
    private static function inspect(array $overrides = []): array
    {
        return array_replace_recursive([
            'HostConfig' => [
                'Privileged' => false,
                'CapAdd' => null,
                'NetworkMode' => 'bridge',
                'PortBindings' => [
                    '80/tcp' => [['HostIp' => '0.0.0.0', 'HostPort' => '8080']],
                ],
            ],
            'Config' => [
                'ExposedPorts' => ['80/tcp' => []],
            ],
        ], $overrides);
    }

    #[Test]
    public function readsPortBindings(): void
    {
        $facts = DockerClient::extractFacts(self::inspect());

        $this->assertSame([
            ['hostIp' => '0.0.0.0', 'hostPort' => 8080, 'containerPort' => 80, 'type' => 'tcp'],
        ], $facts['ports']);
    }

    #[Test]
    public function readsPrivileged(): void
    {
        $this->assertFalse(DockerClient::extractFacts(self::inspect())['privileged']);

        $facts = DockerClient::extractFacts(self::inspect(['HostConfig' => ['Privileged' => true]]));
        $this->assertTrue($facts['privileged']);
    }

    #[Test]
    public function readsAddedCapabilities(): void
    {
        $facts = DockerClient::extractFacts(
            self::inspect(['HostConfig' => ['CapAdd' => ['NET_ADMIN', 'SYS_ADMIN']]])
        );

        $this->assertSame(['NET_ADMIN', 'SYS_ADMIN'], $facts['capAdd']);
    }

    #[Test]
    public function capAddIsAListEvenWhenDockerSendsNull(): void
    {
        $this->assertSame([], DockerClient::extractFacts(self::inspect())['capAdd']);
    }

    #[Test]
    public function keepsExposedPortsInDockersOwnForm(): void
    {
        $facts = DockerClient::extractFacts(
            self::inspect(['Config' => ['ExposedPorts' => ['8989/tcp' => [], '53/udp' => []]]])
        );

        $this->assertSame(['80/tcp', '8989/tcp', '53/udp'], $facts['exposedPorts']);
    }

    #[Test]
    public function readsAnExplicitlySetUser(): void
    {
        $this->assertSame('', DockerClient::extractFacts(self::inspect())['user']);

        $facts = DockerClient::extractFacts(self::inspect(['Config' => ['User' => '0']]));
        $this->assertSame('0', $facts['user']);
    }

    #[Test]
    public function readsPuidAndPgidFromTheEnvironment(): void
    {
        $facts = DockerClient::extractFacts(self::inspect([
            'Config' => ['Env' => ['TZ=America/New_York', 'PUID=1000', 'PGID=100']],
        ]));

        $this->assertSame('1000', $facts['puid']);
        $this->assertSame('100', $facts['pgid']);
    }

    #[Test]
    public function readsUmaskFromTheEnvironment(): void
    {
        $facts = DockerClient::extractFacts(self::inspect([
            'Config' => ['Env' => ['UMASK=002', 'PUID=99']],
        ]));

        $this->assertSame('002', $facts['umask']);
    }

    #[Test]
    public function reportsAnAbsentPuidAsEmpty(): void
    {
        // The common case. Most images pick the user themselves, and the
        // frontend reads an empty value as "this container does not say".
        $facts = DockerClient::extractFacts(self::inspect([
            'Config' => ['Env' => ['TZ=America/New_York']],
        ]));

        $this->assertSame('', $facts['puid']);
        $this->assertSame('', $facts['pgid']);
    }

    #[Test]
    public function keepsAnEqualsSignInsideAnEnvironmentValue(): void
    {
        // Split on the first '=' only: a base64 value or a connection string
        // carries more of them, and splitting on all of them corrupts it.
        $facts = DockerClient::extractFacts(self::inspect([
            'Config' => ['Env' => ['SECRET=a=b=c', 'PUID=99']],
        ]));

        $this->assertSame('99', $facts['puid']);
    }

    #[Test]
    public function ignoresAVariableThatMerelyEndsWithPuid(): void
    {
        $facts = DockerClient::extractFacts(self::inspect([
            'Config' => ['Env' => ['OLD_PUID=1', 'PUID=2']],
        ]));

        $this->assertSame('2', $facts['puid']);
    }

    #[Test]
    public function handlesAnInspectWithNeitherSection(): void
    {
        $facts = DockerClient::extractFacts([]);

        $this->assertSame([
            'ports' => [],
            'privileged' => false,
            'capAdd' => [],
            'exposedPorts' => [],
            'user' => '',
            'puid' => '',
            'pgid' => '',
            'umask' => '',
        ], $facts);
    }

    #[Test]
    public function handlesEmptyObjectsDecodedAsArrays(): void
    {
        // json_decode turns an empty JSON object into [], which is how a
        // container with no bindings and no exposed ports arrives.
        $facts = DockerClient::extractFacts([
            'HostConfig' => ['PortBindings' => [], 'Privileged' => false],
            'Config' => ['ExposedPorts' => []],
        ]);

        $this->assertSame([], $facts['ports']);
        $this->assertSame([], $facts['exposedPorts']);
    }

    #[Test]
    public function skipsAnExposedPortWithNoPublishedBinding(): void
    {
        $facts = DockerClient::extractFacts([
            'HostConfig' => ['PortBindings' => ['80/tcp' => []]],
            'Config' => ['ExposedPorts' => ['80/tcp' => []]],
        ]);

        $this->assertSame([], $facts['ports']);
        $this->assertSame(['80/tcp'], $facts['exposedPorts']);
    }
}
