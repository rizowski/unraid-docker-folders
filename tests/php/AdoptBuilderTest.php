<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/AdoptBuilder.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * The fixtures below are trimmed from a real `docker inspect` of a container
 * created on an Unraid box with:
 *
 *   docker run -d --name=Adopt2 --net=bridge --restart=unless-stopped \
 *     -p 18081:80/tcp -p 18082:53/udp \
 *     -v /mnt/user/appdata/adopt2/html:/usr/share/nginx/html:ro \
 *     -v adopt2-data:/data \
 *     -e TZ=... -e ADOPT2_PLAIN=... -e ADOPT2_PASSWORD=... -e NGINX_VERSION=OVERRIDDEN \
 *     --label com.example.adopt2=yes --cap-add=NET_ADMIN \
 *     --security-opt seccomp=unconfined --shm-size=64m nginx:alpine
 *
 * Using real output matters: several of these fields are shaped differently from
 * what the Docker docs suggest. CapAdd comes back normalised to CAP_NET_ADMIN,
 * a named volume's Mounts.Source is a path under /var/lib/docker rather than the
 * name Unraid needs, and ShmSize is reported even when it was never set.
 */
final class AdoptBuilderTest extends TestCase
{
    private static function inspect(array $overrides = []): array
    {
        $base = [
            'Name' => '/Adopt2',
            'Image' => 'sha256:deadbeef',
            'Config' => [
                'Image' => 'nginx:alpine',
                'Env' => [
                    'TZ=America/Denver',
                    'ADOPT2_PLAIN=value1',
                    'ADOPT2_PASSWORD=sup3rsecret',
                    'NGINX_VERSION=OVERRIDDEN',
                    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                    'NJS_VERSION=1.0.0',
                ],
                'Labels' => [
                    'com.example.adopt2' => 'yes',
                    'maintainer' => 'NGINX Docker Maintainers <docker-maint@nginx.com>',
                ],
            ],
            'HostConfig' => [
                'NetworkMode' => 'bridge',
                'Privileged' => false,
                'RestartPolicy' => ['Name' => 'unless-stopped', 'MaximumRetryCount' => 0],
                'PortBindings' => [
                    '53/udp' => [['HostIp' => '', 'HostPort' => '18082']],
                    '80/tcp' => [['HostIp' => '', 'HostPort' => '18081']],
                ],
                'CapAdd' => ['CAP_NET_ADMIN'],
                'CapDrop' => null,
                'SecurityOpt' => ['seccomp=unconfined'],
                'ShmSize' => 67108864,
                'Runtime' => 'runc',
                'Devices' => [],
                'Ulimits' => [],
            ],
            'Mounts' => [
                [
                    'Type' => 'volume',
                    'Name' => 'adopt2-data',
                    'Source' => '/var/lib/docker/volumes/adopt2-data/_data',
                    'Destination' => '/data',
                    'RW' => true,
                ],
                [
                    'Type' => 'bind',
                    'Source' => '/mnt/user/appdata/adopt2/html',
                    'Destination' => '/usr/share/nginx/html',
                    'RW' => false,
                ],
            ],
            'NetworkSettings' => ['Networks' => ['bridge' => []]],
        ];
        return array_replace_recursive($base, $overrides);
    }

    private static function image(): array
    {
        return [
            'Config' => [
                'Env' => [
                    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                    'NGINX_VERSION=1.31.4',
                    'NJS_VERSION=1.0.0',
                ],
                'Labels' => [
                    'maintainer' => 'NGINX Docker Maintainers <docker-maint@nginx.com>',
                ],
            ],
        ];
    }

    /** @return array<int,array<string,string>> */
    private static function ofType(array $result, string $type): array
    {
        return array_values(array_filter(
            $result['configs'],
            fn(array $c): bool => $c['Type'] === $type
        ));
    }

    // ─── scalars ──────────────────────────────────────────────────────

    #[Test]
    public function emits_every_scalar_key_even_when_empty(): void
    {
        // postToXML reads most of these without a null-coalesce, so a missing
        // key is a PHP warning on Unraid's side, not a harmless omission.
        $required = [
            'contName', 'contRepository', 'contRegistry', 'contNetwork', 'contMyIP',
            'contShell', 'contSupport', 'contProject', 'contReadMe', 'contOverview',
            'contCategory', 'contWebUI', 'contTemplateURL', 'contIcon', 'contPostArgs',
            'contCPUset', 'contDonateText', 'contDonateLink', 'contRequires',
            'contPrivileged', 'contMyMAC', 'contExtraParams',
        ];


        $fields = AdoptBuilder::build(self::inspect(), self::image())['fields'];

        foreach ($required as $key) {
            $this->assertArrayHasKey($key, $fields, "missing POST field $key");
        }
    }

    #[Test]
    public function sends_the_tailscale_state_dir_even_though_tailscale_is_off(): void
    {
        // postToXML reads $post['TSstatedir'] at Helpers.php:198, which is
        // OUTSIDE the `if contTailscale == on` branch above it. Leaving it out
        // makes Unraid print a PHP warning into its own response on every adopt.
        $fields = AdoptBuilder::build(self::inspect(), self::image())['fields'];

        $this->assertArrayHasKey('TSstatedir', $fields);
        $this->assertSame('', $fields['TSstatedir']);
    }

    #[Test]
    public function maps_name_repository_and_network(): void
    {
        $fields = AdoptBuilder::build(self::inspect(), self::image())['fields'];

        $this->assertSame('Adopt2', $fields['contName']);
        $this->assertSame('nginx:alpine', $fields['contRepository']);
        $this->assertSame('bridge', $fields['contNetwork']);
    }

    #[Test]
    public function leaves_webui_and_icon_empty(): void
    {
        // Neither exists in Docker. Inventing them would write a wrong value
        // into the user's template and into the stamped labels.
        $fields = AdoptBuilder::build(self::inspect(), self::image())['fields'];

        $this->assertSame('', $fields['contWebUI']);
        $this->assertSame('', $fields['contIcon']);
    }

    // ─── environment diffing ──────────────────────────────────────────

    #[Test]
    public function keeps_only_user_set_variables(): void
    {
        $vars = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Variable');
        $names = array_column($vars, 'Target');

        sort($names);
        $this->assertSame(
            ['ADOPT2_PASSWORD', 'ADOPT2_PLAIN', 'NGINX_VERSION', 'TZ'],
            $names
        );
    }

    #[Test]
    public function keeps_an_image_variable_the_user_overrode(): void
    {
        $vars = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Variable');
        $byName = array_column($vars, 'Value', 'Target');

        $this->assertSame('OVERRIDDEN', $byName['NGINX_VERSION']);
    }

    #[Test]
    public function drops_variables_unraid_injects_itself(): void
    {
        $inspect = self::inspect();
        $inspect['Config']['Env'][] = 'HOST_OS=Unraid';
        $inspect['Config']['Env'][] = 'HOST_HOSTNAME=Tower';
        $inspect['Config']['Env'][] = 'HOST_CONTAINERNAME=Adopt2';

        $names = array_column(self::ofType(AdoptBuilder::build($inspect, self::image()), 'Variable'), 'Target');

        $this->assertNotContains('HOST_OS', $names);
        $this->assertNotContains('HOST_HOSTNAME', $names);
        $this->assertNotContains('HOST_CONTAINERNAME', $names);
    }

    #[Test]
    public function keeps_every_variable_when_the_image_is_unknown(): void
    {
        // Degraded rather than wrong: without the image there is nothing to diff
        // against, so dropping anything would risk losing a real setting.
        $result = AdoptBuilder::build(self::inspect(), []);

        $this->assertFalse($result['imageEnvKnown']);
        $this->assertCount(6, self::ofType($result, 'Variable'));
    }

    #[Test]
    public function splits_a_value_containing_equals_signs_correctly(): void
    {
        $inspect = self::inspect();
        $inspect['Config']['Env'][] = 'CONN=user=admin;pw=a==b';

        $vars = self::ofType(AdoptBuilder::build($inspect, self::image()), 'Variable');
        $byName = array_column($vars, 'Value', 'Target');

        $this->assertSame('user=admin;pw=a==b', $byName['CONN']);
    }

    #[Test]
    public function masks_variables_that_look_like_secrets(): void
    {
        $vars = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Variable');
        $byName = array_column($vars, 'Mask', 'Target');

        $this->assertSame('true', $byName['ADOPT2_PASSWORD']);
        $this->assertSame('false', $byName['ADOPT2_PLAIN']);
    }

    // ─── ports ────────────────────────────────────────────────────────

    #[Test]
    public function maps_ports_with_their_protocol(): void
    {
        $ports = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Port');
        $byTarget = [];
        foreach ($ports as $p) {
            $byTarget[$p['Target']] = [$p['Value'], $p['Mode']];
        }

        $this->assertSame(['18081', 'tcp'], $byTarget['80']);
        $this->assertSame(['18082', 'udp'], $byTarget['53']);
    }

    #[Test]
    public function reports_a_port_bound_to_one_address(): void
    {
        // The template's Port type publishes on every address. Silently widening
        // a loopback-only binding is a security change, so it is reported.
        $inspect = self::inspect();
        $inspect['HostConfig']['PortBindings'] = [
            '80/tcp' => [['HostIp' => '127.0.0.1', 'HostPort' => '18081']],
        ];

        $result = AdoptBuilder::build($inspect, self::image());

        $this->assertNotEmpty($result['unmapped']);
        $this->assertStringContainsString('127.0.0.1', $result['unmapped'][0]);
    }

    // ─── paths ────────────────────────────────────────────────────────

    #[Test]
    public function emits_only_bind_mounts_as_paths(): void
    {
        // A named volume must NOT be a Path config. xmlToCommand mkdirs the host
        // side of every Path that does not exist, and a volume's host side is a
        // bare name — verified on a real box, where it created an empty
        // "adopt2-data" directory relative to the PHP process's cwd.
        $paths = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Path');
        $targets = array_column($paths, 'Target');

        $this->assertSame(['/usr/share/nginx/html'], $targets);
    }

    #[Test]
    public function routes_a_named_volume_through_extra_params(): void
    {
        $extra = AdoptBuilder::build(self::inspect(), self::image())['fields']['contExtraParams'];

        $this->assertStringContainsString("-v 'adopt2-data':'/data':rw", $extra);
    }

    #[Test]
    public function preserves_a_read_only_mount(): void
    {
        $paths = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Path');
        $byTarget = array_column($paths, 'Mode', 'Target');

        $this->assertSame('ro', $byTarget['/usr/share/nginx/html']);
    }

    #[Test]
    public function preserves_a_read_only_named_volume(): void
    {
        $inspect = self::inspect();
        $inspect['Mounts'][0]['RW'] = false;

        $extra = AdoptBuilder::build($inspect, self::image())['fields']['contExtraParams'];

        $this->assertStringContainsString("-v 'adopt2-data':'/data':ro", $extra);
    }

    // ─── port publishing ──────────────────────────────────────────────

    #[Test]
    public function reports_ports_as_published_on_a_bridge_network(): void
    {
        $result = AdoptBuilder::build(self::inspect(), self::image(), 'bridge');

        $this->assertTrue($result['portsPublished']);
        $this->assertSame('bridge', $result['networkDriver']);
    }

    #[Test]
    public function reports_ports_as_unpublished_on_macvlan_and_ipvlan(): void
    {
        // Unraid converts every port into a TCP_PORT_n variable on these
        // drivers and emits no -p at all. Confirmed against its own
        // xmlToCommand with a container moved to br0.
        foreach (['macvlan', 'ipvlan', 'host'] as $driver) {
            $result = AdoptBuilder::build(self::inspect(), self::image(), $driver);
            $this->assertFalse($result['portsPublished'], "expected no publishing on $driver");
        }
    }

    #[Test]
    public function reports_ports_as_unpublished_when_sharing_another_namespace(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['NetworkMode'] = 'container:abc123';

        $this->assertFalse(AdoptBuilder::build($inspect, self::image())['portsPublished']);
    }

    #[Test]
    public function assumes_ports_are_published_when_the_driver_is_unknown(): void
    {
        // Bridge is overwhelmingly the common case, and a false warning on every
        // adopt would train the user to ignore the real one.
        $this->assertTrue(AdoptBuilder::build(self::inspect(), self::image())['portsPublished']);
    }

    // ─── labels ───────────────────────────────────────────────────────

    #[Test]
    public function keeps_user_labels_and_drops_image_labels(): void
    {
        $labels = self::ofType(AdoptBuilder::build(self::inspect(), self::image()), 'Label');
        $names = array_column($labels, 'Target');

        $this->assertSame(['com.example.adopt2'], $names);
    }

    #[Test]
    public function drops_unraid_and_compose_labels(): void
    {
        $inspect = self::inspect();
        $inspect['Config']['Labels']['net.unraid.docker.managed'] = 'dockerman';
        $inspect['Config']['Labels']['com.docker.compose.project'] = 'stack';

        $names = array_column(self::ofType(AdoptBuilder::build($inspect, self::image()), 'Label'), 'Target');

        $this->assertSame(['com.example.adopt2'], $names);
    }

    // ─── devices ──────────────────────────────────────────────────────

    #[Test]
    public function maps_a_device_to_its_host_path(): void
    {
        // xmlToCommand emits --device=<Value> and ignores Target for this type.
        $inspect = self::inspect();
        $inspect['HostConfig']['Devices'] = [
            ['PathOnHost' => '/dev/dri', 'PathInContainer' => '/dev/dri', 'CgroupPermissions' => 'rwm'],
        ];

        $devices = self::ofType(AdoptBuilder::build($inspect, self::image()), 'Device');

        $this->assertCount(1, $devices);
        $this->assertSame('/dev/dri', $devices[0]['Value']);
    }

    // ─── extra params ─────────────────────────────────────────────────

    #[Test]
    public function renders_recognised_flags_into_extra_params(): void
    {
        $extra = AdoptBuilder::build(self::inspect(), self::image())['fields']['contExtraParams'];

        $this->assertStringContainsString('--restart=unless-stopped', $extra);
        $this->assertStringContainsString('--cap-add=CAP_NET_ADMIN', $extra);
        $this->assertStringContainsString('--security-opt seccomp=unconfined', $extra);
    }

    #[Test]
    public function omits_shm_size_when_it_is_dockers_default(): void
    {
        // Every container reports 67108864 whether or not --shm-size was given.
        $extra = AdoptBuilder::build(self::inspect(), self::image())['fields']['contExtraParams'];

        $this->assertStringNotContainsString('--shm-size', $extra);
    }

    #[Test]
    public function emits_shm_size_when_it_is_not_the_default(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['ShmSize'] = 1073741824;

        $extra = AdoptBuilder::build($inspect, self::image())['fields']['contExtraParams'];

        $this->assertStringContainsString('--shm-size=1073741824', $extra);
    }

    #[Test]
    public function omits_a_restart_policy_of_no(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['RestartPolicy'] = ['Name' => 'no', 'MaximumRetryCount' => 0];

        $extra = AdoptBuilder::build($inspect, self::image())['fields']['contExtraParams'];

        $this->assertStringNotContainsString('--restart', $extra);
    }

    #[Test]
    public function keeps_the_retry_count_on_an_on_failure_policy(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['RestartPolicy'] = ['Name' => 'on-failure', 'MaximumRetryCount' => 5];

        $extra = AdoptBuilder::build($inspect, self::image())['fields']['contExtraParams'];

        $this->assertStringContainsString('--restart=on-failure:5', $extra);
    }

    #[Test]
    public function reports_settings_it_cannot_express(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['Tmpfs'] = ['/run' => 'rw,size=64m'];
        $inspect['HostConfig']['DeviceRequests'] = [['Driver' => 'nvidia']];

        $unmapped = AdoptBuilder::build($inspect, self::image())['unmapped'];

        $this->assertStringContainsString('--tmpfs', implode(' ', $unmapped));
        $this->assertStringContainsString('--gpus', implode(' ', $unmapped));
    }

    #[Test]
    public function a_plain_container_reports_nothing_unmapped(): void
    {
        // The guard against a warning that cries wolf on every adopt.
        $this->assertSame([], AdoptBuilder::build(self::inspect(), self::image())['unmapped']);
    }

    // ─── command override ─────────────────────────────────────────────

    #[Test]
    public function carries_a_command_the_user_overrode(): void
    {
        $inspect = self::inspect();
        $inspect['Config']['Cmd'] = ['nginx', '-g', 'daemon off; worker_processes 2;'];
        $image = self::image();
        $image['Config']['Cmd'] = ['nginx', '-g', 'daemon off;'];

        $fields = AdoptBuilder::build($inspect, $image)['fields'];

        $this->assertSame('nginx -g daemon off; worker_processes 2;', $fields['contPostArgs']);
    }

    #[Test]
    public function ignores_a_command_that_came_from_the_image(): void
    {
        $inspect = self::inspect();
        $inspect['Config']['Cmd'] = ['nginx', '-g', 'daemon off;'];
        $image = self::image();
        $image['Config']['Cmd'] = ['nginx', '-g', 'daemon off;'];

        $fields = AdoptBuilder::build($inspect, $image)['fields'];

        $this->assertSame('', $fields['contPostArgs']);
    }

    // ─── networking ───────────────────────────────────────────────────

    #[Test]
    public function carries_a_pinned_ip_on_a_custom_network(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['NetworkMode'] = 'br0';
        $inspect['NetworkSettings']['Networks'] = [
            'br0' => ['IPAMConfig' => ['IPv4Address' => '10.1.1.50']],
        ];

        $fields = AdoptBuilder::build($inspect, self::image())['fields'];

        $this->assertSame('br0', $fields['contNetwork']);
        $this->assertSame('10.1.1.50', $fields['contMyIP']);
    }

    #[Test]
    public function marks_a_privileged_container(): void
    {
        $inspect = self::inspect();
        $inspect['HostConfig']['Privileged'] = true;

        $fields = AdoptBuilder::build($inspect, self::image())['fields'];

        $this->assertSame('on', $fields['contPrivileged']);
    }
}
