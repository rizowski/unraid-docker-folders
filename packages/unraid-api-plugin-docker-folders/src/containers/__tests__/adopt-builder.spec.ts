import { describe, expect, it } from 'vitest';

import { build, type AdoptConfigEntry } from '../adopt-builder.js';
import type { DockerFoldersRawImageInspect, DockerFoldersRawInspect } from '../extras-docker-client.js';

/**
 * A line-for-line translation of `tests/php/AdoptBuilderTest.php`. The
 * fixtures are the same ones the PHP file documents as trimmed from a real
 * `docker inspect`, created with:
 *
 *   docker run -d --name=Adopt2 --net=bridge --restart=unless-stopped \
 *     -p 18081:80/tcp -p 18082:53/udp \
 *     -v /mnt/user/appdata/adopt2/html:/usr/share/nginx/html:ro \
 *     -v adopt2-data:/data \
 *     -e TZ=... -e ADOPT2_PLAIN=... -e ADOPT2_PASSWORD=... -e NGINX_VERSION=OVERRIDDEN \
 *     --label com.example.adopt2=yes --cap-add=NET_ADMIN \
 *     --security-opt seccomp=unconfined --shm-size=64m nginx:alpine
 *
 * `baseInspect()` returns a fresh object every call, mirroring the PHP
 * function's fresh array literal; tests that need a variant mutate their own
 * copy directly, the same way the PHP tests do, rather than going through a
 * generic deep-merge helper.
 */

function baseInspect(): DockerFoldersRawInspect {
    return {
        Name: '/Adopt2',
        Image: 'sha256:deadbeef',
        Config: {
            Image: 'nginx:alpine',
            Env: [
                'TZ=America/Denver',
                'ADOPT2_PLAIN=value1',
                'ADOPT2_PASSWORD=sup3rsecret',
                'NGINX_VERSION=OVERRIDDEN',
                'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                'NJS_VERSION=1.0.0',
            ],
            Labels: {
                'com.example.adopt2': 'yes',
                maintainer: 'NGINX Docker Maintainers <docker-maint@nginx.com>',
            },
        },
        HostConfig: {
            NetworkMode: 'bridge',
            Privileged: false,
            RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
            PortBindings: {
                '53/udp': [{ HostIp: '', HostPort: '18082' }],
                '80/tcp': [{ HostIp: '', HostPort: '18081' }],
            },
            CapAdd: ['CAP_NET_ADMIN'],
            CapDrop: null,
            SecurityOpt: ['seccomp=unconfined'],
            ShmSize: 67108864,
            Runtime: 'runc',
            Devices: [],
            Ulimits: [],
        },
        Mounts: [
            {
                Type: 'volume',
                Name: 'adopt2-data',
                Source: '/var/lib/docker/volumes/adopt2-data/_data',
                Destination: '/data',
                RW: true,
            },
            {
                Type: 'bind',
                Source: '/mnt/user/appdata/adopt2/html',
                Destination: '/usr/share/nginx/html',
                RW: false,
            },
        ],
        NetworkSettings: { Networks: { bridge: {} } },
    };
}

function baseImage(): DockerFoldersRawImageInspect {
    return {
        Config: {
            Env: [
                'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                'NGINX_VERSION=1.31.4',
                'NJS_VERSION=1.0.0',
            ],
            Labels: {
                maintainer: 'NGINX Docker Maintainers <docker-maint@nginx.com>',
            },
        },
    };
}

function ofType(result: ReturnType<typeof build>, type: string): AdoptConfigEntry[] {
    return result.configs.filter((c) => c.Type === type);
}

// ─── scalars ──────────────────────────────────────────────────────

describe('scalars', () => {
    it('emits every scalar key even when empty', () => {
        const required = [
            'contName', 'contRepository', 'contRegistry', 'contNetwork', 'contMyIP',
            'contShell', 'contSupport', 'contProject', 'contReadMe', 'contOverview',
            'contCategory', 'contWebUI', 'contTemplateURL', 'contIcon', 'contPostArgs',
            'contCPUset', 'contDonateText', 'contDonateLink', 'contRequires',
            'contPrivileged', 'contMyMAC', 'contExtraParams',
        ];

        const { fields } = build(baseInspect(), baseImage());

        for (const key of required) {
            expect(fields, `missing POST field ${key}`).toHaveProperty(key);
        }
    });

    it('sends the tailscale state dir even though tailscale is off', () => {
        const { fields } = build(baseInspect(), baseImage());

        expect(fields).toHaveProperty('TSstatedir');
        expect(fields.TSstatedir).toBe('');
    });

    it('maps name, repository, and network', () => {
        const { fields } = build(baseInspect(), baseImage());

        expect(fields.contName).toBe('Adopt2');
        expect(fields.contRepository).toBe('nginx:alpine');
        expect(fields.contNetwork).toBe('bridge');
    });

    it('leaves webui and icon empty', () => {
        const { fields } = build(baseInspect(), baseImage());

        expect(fields.contWebUI).toBe('');
        expect(fields.contIcon).toBe('');
    });
});

// ─── environment diffing ──────────────────────────────────────────

describe('environment diffing', () => {
    it('keeps only user-set variables', () => {
        const vars = ofType(build(baseInspect(), baseImage()), 'Variable');
        const names = vars.map((v) => v.Target).sort();

        expect(names).toEqual(['ADOPT2_PASSWORD', 'ADOPT2_PLAIN', 'NGINX_VERSION', 'TZ']);
    });

    it('keeps an image variable the user overrode', () => {
        const vars = ofType(build(baseInspect(), baseImage()), 'Variable');
        const byName = Object.fromEntries(vars.map((v) => [v.Target, v.Value]));

        expect(byName.NGINX_VERSION).toBe('OVERRIDDEN');
    });

    it('drops variables Unraid injects itself', () => {
        const inspect = baseInspect();
        inspect.Config!.Env!.push('HOST_OS=Unraid', 'HOST_HOSTNAME=Tower', 'HOST_CONTAINERNAME=Adopt2');

        const names = ofType(build(inspect, baseImage()), 'Variable').map((v) => v.Target);

        expect(names).not.toContain('HOST_OS');
        expect(names).not.toContain('HOST_HOSTNAME');
        expect(names).not.toContain('HOST_CONTAINERNAME');
    });

    it('keeps every variable when the image is unknown', () => {
        const result = build(baseInspect(), {});

        expect(result.imageEnvKnown).toBe(false);
        expect(ofType(result, 'Variable')).toHaveLength(6);
    });

    it('splits a value containing equals signs correctly', () => {
        const inspect = baseInspect();
        inspect.Config!.Env!.push('CONN=user=admin;pw=a==b');

        const vars = ofType(build(inspect, baseImage()), 'Variable');
        const byName = Object.fromEntries(vars.map((v) => [v.Target, v.Value]));

        expect(byName.CONN).toBe('user=admin;pw=a==b');
    });

    it('masks variables that look like secrets', () => {
        const vars = ofType(build(baseInspect(), baseImage()), 'Variable');
        const byName = Object.fromEntries(vars.map((v) => [v.Target, v.Mask]));

        expect(byName.ADOPT2_PASSWORD).toBe('true');
        expect(byName.ADOPT2_PLAIN).toBe('false');
    });
});

// ─── ports ────────────────────────────────────────────────────────

describe('ports', () => {
    it('maps ports with their protocol', () => {
        const ports = ofType(build(baseInspect(), baseImage()), 'Port');
        const byTarget = Object.fromEntries(ports.map((p) => [p.Target, [p.Value, p.Mode]]));

        expect(byTarget['80']).toEqual(['18081', 'tcp']);
        expect(byTarget['53']).toEqual(['18082', 'udp']);
    });

    it('reports a port bound to one address', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.PortBindings = {
            '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '18081' }],
        };

        const result = build(inspect, baseImage());

        expect(result.unmapped.length).toBeGreaterThan(0);
        expect(result.unmapped[0]).toContain('127.0.0.1');
    });
});

// ─── paths ────────────────────────────────────────────────────────

describe('paths', () => {
    it('emits only bind mounts as paths', () => {
        const paths = ofType(build(baseInspect(), baseImage()), 'Path');
        expect(paths.map((p) => p.Target)).toEqual(['/usr/share/nginx/html']);
    });

    it('routes a named volume through extra params', () => {
        const extra = build(baseInspect(), baseImage()).fields.contExtraParams;
        expect(extra).toContain("-v 'adopt2-data':'/data':rw");
    });

    it('preserves a read-only mount', () => {
        const paths = ofType(build(baseInspect(), baseImage()), 'Path');
        const byTarget = Object.fromEntries(paths.map((p) => [p.Target, p.Mode]));

        expect(byTarget['/usr/share/nginx/html']).toBe('ro');
    });

    it('preserves a read-only named volume', () => {
        const inspect = baseInspect();
        inspect.Mounts![0].RW = false;

        const extra = build(inspect, baseImage()).fields.contExtraParams;
        expect(extra).toContain("-v 'adopt2-data':'/data':ro");
    });
});

// ─── port publishing ──────────────────────────────────────────────

describe('port publishing', () => {
    it('reports ports as published on a bridge network', () => {
        const result = build(baseInspect(), baseImage(), 'bridge');

        expect(result.portsPublished).toBe(true);
        expect(result.networkDriver).toBe('bridge');
    });

    it('reports ports as unpublished on macvlan, ipvlan, and host', () => {
        for (const driver of ['macvlan', 'ipvlan', 'host']) {
            const result = build(baseInspect(), baseImage(), driver);
            expect(result.portsPublished, `expected no publishing on ${driver}`).toBe(false);
        }
    });

    it('reports ports as unpublished when sharing another namespace', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.NetworkMode = 'container:abc123';

        expect(build(inspect, baseImage()).portsPublished).toBe(false);
    });

    it('assumes ports are published when the driver is unknown', () => {
        expect(build(baseInspect(), baseImage()).portsPublished).toBe(true);
    });
});

// ─── labels ───────────────────────────────────────────────────────

describe('labels', () => {
    it('keeps user labels and drops image labels', () => {
        const labels = ofType(build(baseInspect(), baseImage()), 'Label');
        expect(labels.map((l) => l.Target)).toEqual(['com.example.adopt2']);
    });

    it('drops unraid and compose labels', () => {
        const inspect = baseInspect();
        inspect.Config!.Labels!['net.unraid.docker.managed'] = 'dockerman';
        inspect.Config!.Labels!['com.docker.compose.project'] = 'stack';

        const names = ofType(build(inspect, baseImage()), 'Label').map((l) => l.Target);
        expect(names).toEqual(['com.example.adopt2']);
    });
});

// ─── devices ──────────────────────────────────────────────────────

describe('devices', () => {
    it('maps a device to its host path', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.Devices = [
            { PathOnHost: '/dev/dri', PathInContainer: '/dev/dri' },
        ];

        const devices = ofType(build(inspect, baseImage()), 'Device');

        expect(devices).toHaveLength(1);
        expect(devices[0].Value).toBe('/dev/dri');
    });
});

// ─── extra params ─────────────────────────────────────────────────

describe('extra params', () => {
    it('renders recognised flags into extra params', () => {
        const extra = build(baseInspect(), baseImage()).fields.contExtraParams;

        expect(extra).toContain("--restart='unless-stopped'");
        expect(extra).toContain("--cap-add='CAP_NET_ADMIN'");
        expect(extra).toContain("--security-opt 'seccomp=unconfined'");
    });

    it("omits shm-size when it is Docker's default", () => {
        const extra = build(baseInspect(), baseImage()).fields.contExtraParams;
        expect(extra).not.toContain('--shm-size');
    });

    it('emits shm-size when it is not the default', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.ShmSize = 1073741824;

        const extra = build(inspect, baseImage()).fields.contExtraParams;
        expect(extra).toContain('--shm-size=1073741824');
    });

    it('omits a restart policy of "no"', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.RestartPolicy = { Name: 'no', MaximumRetryCount: 0 };

        const extra = build(inspect, baseImage()).fields.contExtraParams;
        expect(extra).not.toContain('--restart');
    });

    it('keeps the retry count on an on-failure policy', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.RestartPolicy = { Name: 'on-failure', MaximumRetryCount: 5 };

        const extra = build(inspect, baseImage()).fields.contExtraParams;
        expect(extra).toContain("--restart='on-failure:5'");
    });

    it('reports settings it cannot express', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.Tmpfs = { '/run': 'rw,size=64m' };
        inspect.HostConfig!.DeviceRequests = [{ Driver: 'nvidia' }];

        const unmapped = build(inspect, baseImage()).unmapped;

        expect(unmapped.join(' ')).toContain('--tmpfs');
        expect(unmapped.join(' ')).toContain('--gpus');
    });

    it('a plain container reports nothing unmapped', () => {
        expect(build(baseInspect(), baseImage()).unmapped).toEqual([]);
    });
});

// ─── command override ─────────────────────────────────────────────

describe('command override', () => {
    it('carries a command the user overrode', () => {
        const inspect = baseInspect();
        inspect.Config!.Cmd = ['nginx', '-g', 'daemon off; worker_processes 2;'];
        const image = baseImage();
        image.Config!.Cmd = ['nginx', '-g', 'daemon off;'];

        const { fields } = build(inspect, image);
        expect(fields.contPostArgs).toBe("'nginx' '-g' 'daemon off; worker_processes 2;'");
    });

    it('ignores a command that came from the image', () => {
        const inspect = baseInspect();
        inspect.Config!.Cmd = ['nginx', '-g', 'daemon off;'];
        const image = baseImage();
        image.Config!.Cmd = ['nginx', '-g', 'daemon off;'];

        const { fields } = build(inspect, image);
        expect(fields.contPostArgs).toBe('');
    });
});

// ─── networking ───────────────────────────────────────────────────

describe('networking', () => {
    it('carries a pinned IP on a custom network', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.NetworkMode = 'br0';
        inspect.NetworkSettings = { Networks: { br0: { IPAMConfig: { IPv4Address: '10.1.1.50' } } } };

        const { fields } = build(inspect, baseImage());

        expect(fields.contNetwork).toBe('br0');
        expect(fields.contMyIP).toBe('10.1.1.50');
    });

    it('marks a privileged container', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.Privileged = true;

        const { fields } = build(inspect, baseImage());
        expect(fields.contPrivileged).toBe('on');
    });
});

// ─── shell safety ─────────────────────────────────────────────────

describe('shell safety', () => {
    it('neutralises a semicolon in a command override', () => {
        const inspect = baseInspect();
        inspect.Config!.Cmd = ['nginx', '-g', 'daemon off; touch /tmp/pwned'];
        const image = baseImage();
        image.Config!.Cmd = ['nginx'];

        const postArgs = build(inspect, image).fields.contPostArgs;
        expect(postArgs).toBe("'nginx' '-g' 'daemon off; touch /tmp/pwned'");
    });

    it('keeps argv boundaries in a command override', () => {
        const inspect = baseInspect();
        inspect.Config!.Cmd = ['sh', '-c', 'echo one two'];
        const image = baseImage();
        image.Config!.Cmd = ['nginx'];

        const postArgs = build(inspect, image).fields.contPostArgs;
        expect(postArgs).toBe("'sh' '-c' 'echo one two'");
    });

    it('neutralises shell metacharacters in host config values', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.SecurityOpt = ['seccomp=unconfined; touch /tmp/pwned'];
        inspect.HostConfig!.CapAdd = ['NET_ADMIN`id`'];
        inspect.HostConfig!.ExtraHosts = ['evil:1.2.3.4 && reboot'];

        const extra = build(inspect, baseImage()).fields.contExtraParams;

        expect(extra).toContain("--security-opt 'seccomp=unconfined; touch /tmp/pwned'");
        expect(extra).toContain("--cap-add='NET_ADMIN`id`'");
        expect(extra).toContain("--add-host='evil:1.2.3.4 && reboot'");
    });

    it('escapes a quote in a value rather than breaking out', () => {
        const inspect = baseInspect();
        inspect.HostConfig!.SecurityOpt = ["a'; touch /tmp/pwned; '"];

        const extra = build(inspect, baseImage()).fields.contExtraParams;

        const expected = "--security-opt " + "'a'\\''; touch /tmp/pwned; '\\'''";
        expect(extra).toContain(expected);
    });
});
