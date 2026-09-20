import { describe, it, expect } from 'vitest';
import {
  DOCS,
  FINDING_TYPES,
  findingsFor,
  isForcedRoot,
  parseExposedPort,
  suggestHostPort,
  type PortOwners,
  type SecurityFinding,
} from '@/utils/securityFindings';
import { makeContainer } from '@/test/fixtures';

const noPorts: PortOwners = new Map();

const typesOf = (container: Parameters<typeof findingsFor>[0], bound = noPorts) =>
  findingsFor(container, bound).map((f) => f.type);

/** Detail rows flattened, for assertions that do not care about the columns. */
const detailText = (finding: SecurityFinding) =>
  (finding.detail ?? []).map((d) => [d.remove, d.add, d.note].filter(Boolean).join(' ')).join('\n');

/** The left column: what the advisor detected. */
const removals = (finding: SecurityFinding) =>
  (finding.detail ?? []).map((d) => d.remove).filter(Boolean);

/** The right column: what it recommends instead. */
const additions = (finding: SecurityFinding) =>
  (finding.detail ?? []).map((d) => d.add).filter(Boolean);

describe('FINDING_TYPES', () => {
  // The same six strings are the write-side allowlist in
  // SecurityAdvisor::FINDING_TYPES, because PHP and TypeScript share no source.
  // SecurityAdvisorTest asserts the identical list, so adding a finding type on
  // one side alone fails a test rather than shipping a dismissal the backend
  // rejects with a 400.
  it('matches the backend allowlist', () => {
    expect([...FINDING_TYPES]).toEqual([
      'privileged',
      'docker-socket',
      'host-network',
      'added-capabilities',
      'broad-mount',
      'forced-root',
    ]);
  });

  it('documents every type', () => {
    expect(Object.keys(DOCS).sort()).toEqual([...FINDING_TYPES].sort());
  });
});

describe('parseExposedPort', () => {
  it('splits port and protocol', () => {
    expect(parseExposedPort('8989/tcp')).toEqual({ port: 8989, proto: 'tcp' });
    expect(parseExposedPort('53/udp')).toEqual({ port: 53, proto: 'udp' });
  });

  it('defaults a bare port to tcp', () => {
    expect(parseExposedPort('80')).toEqual({ port: 80, proto: 'tcp' });
  });

  it('returns null for junk', () => {
    expect(parseExposedPort('')).toBeNull();
    expect(parseExposedPort('abc/tcp')).toBeNull();
  });
});

describe('suggestHostPort', () => {
  it('keeps the port when nothing holds it', () => {
    expect(suggestHostPort(8989, noPorts)).toEqual({ port: 8989, takenBy: null });
  });

  it('steps up past a held port and names the holder', () => {
    const bound: PortOwners = new Map([[8989, 'sonarr']]);
    expect(suggestHostPort(8989, bound)).toEqual({ port: 8990, takenBy: 'sonarr' });
  });

  it('keeps stepping while ports stay held', () => {
    const bound: PortOwners = new Map([
      [3000, 'grafana'],
      [3001, 'uptime'],
      [3002, 'gitea'],
    ]);
    expect(suggestHostPort(3000, bound)).toEqual({ port: 3003, takenBy: 'grafana' });
  });

  it('does not report a container as conflicting with itself', () => {
    const bound: PortOwners = new Map([[8123, 'homeassistant']]);
    expect(suggestHostPort(8123, bound, 'homeassistant')).toEqual({ port: 8123, takenBy: null });
  });
});

describe('isForcedRoot', () => {
  it('stays silent when the image chose the user', () => {
    // The normal case on an Unraid box, including every linuxserver.io image.
    expect(isForcedRoot('')).toBe(false);
    expect(isForcedRoot('   ')).toBe(false);
  });

  it('stays silent for any non-root user', () => {
    expect(isForcedRoot('1000')).toBe(false);
    expect(isForcedRoot('1000:1000')).toBe(false);
    expect(isForcedRoot('abc')).toBe(false);
  });

  it('fires when the template pins uid 0', () => {
    expect(isForcedRoot('0')).toBe(true);
    expect(isForcedRoot('root')).toBe(true);
    expect(isForcedRoot('ROOT')).toBe(true);
    expect(isForcedRoot('0:0')).toBe(true);
    expect(isForcedRoot('root:root')).toBe(true);
  });
});

describe('findingsFor', () => {
  it('returns nothing for an ordinary bridged container', () => {
    const container = makeContainer({
      mounts: [{ Source: '/mnt/user/appdata/sonarr', Destination: '/config', Type: 'bind', RW: true }],
    });
    expect(typesOf(container)).toEqual([]);
  });

  it('flags privileged mode as critical', () => {
    const findings = findingsFor(makeContainer({ privileged: true }), noPorts);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('privileged');
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].fix).toContain('test-container');
  });

  it('flags a mounted docker socket', () => {
    const container = makeContainer({
      mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Type: 'bind', RW: true }],
    });
    const findings = findingsFor(container, noPorts);
    expect(findings.map((f) => f.type)).toEqual(['docker-socket']);
    expect(findings[0].severity).toBe('critical');
    expect(detailText(findings[0])).not.toContain('read-only');
  });

  it('says so when the socket is mounted read-only', () => {
    const container = makeContainer({
      mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Type: 'bind', RW: false }],
    });
    const [finding] = findingsFor(container, noPorts);
    expect(removals(finding)).toEqual(['/var/run/docker.sock -> /var/run/docker.sock (Read Only)']);
    expect(detailText(finding)).toContain('Read-only changes nothing here');
    expect(finding.fix).toContain('Read-only stops nothing');
  });

  it('ranks SYS_ADMIN above an ordinary capability', () => {
    const ordinary = findingsFor(makeContainer({ capAdd: ['NET_ADMIN'] }), noPorts)[0];
    expect(ordinary.severity).toBe('warning');
    expect(removals(ordinary)).toEqual(['--cap-add=NET_ADMIN']);

    const worst = findingsFor(makeContainer({ capAdd: ['sys_admin'] }), noPorts)[0];
    expect(worst.severity).toBe('critical');
    expect(worst.title).toContain('SYS_ADMIN');
  });

  it('offers no replacement for a capability, because there is none', () => {
    // --cap-drop=ALL --cap-add=<the same capability> reads like hardening and is
    // not: it keeps the dangerous capability and strips the fourteen defaults an
    // image needs to drop from root at startup.
    const [finding] = findingsFor(makeContainer({ name: 'vpn', capAdd: ['NET_ADMIN'] }), noPorts);
    expect(finding.fix).toContain('Edit vpn in Unraid');
    expect(finding.fix).toContain('take the flag out');
    expect(additions(finding)).toEqual([]);
  });

  it('lists every added capability on its own row', () => {
    const [finding] = findingsFor(makeContainer({ capAdd: ['NET_ADMIN', 'SYS_NICE'] }), noPorts);
    expect(removals(finding)).toEqual(['--cap-add=NET_ADMIN', '--cap-add=SYS_NICE']);
    expect(additions(finding)).toEqual([]);
  });

  it('explains a capability it knows about in the note, not the column', () => {
    const vpn = findingsFor(makeContainer({ capAdd: ['NET_ADMIN'] }), noPorts)[0];
    expect(detailText(vpn)).toContain('If the container runs a VPN tunnel');

    const fuse = findingsFor(makeContainer({ capAdd: ['SYS_ADMIN'] }), noPorts)[0];
    expect(detailText(fuse)).toContain('no narrower substitute');

    const raw = findingsFor(makeContainer({ capAdd: ['NET_RAW'] }), noPorts)[0];
    expect(detailText(raw)).toContain('default set already');
  });

  it('replaces ALL with one named capability, keeping the defaults', () => {
    const [finding] = findingsFor(makeContainer({ capAdd: ['ALL'] }), noPorts);
    expect(additions(finding)).toEqual(['--cap-add=<capability>']);
  });

  it('strips the CAP_ prefix Docker reports for an added capability', () => {
    // A real inspect comes back as CAP_NET_ADMIN, not NET_ADMIN.
    const [finding] = findingsFor(makeContainer({ capAdd: ['CAP_NET_ADMIN'] }), noPorts);
    expect(removals(finding)).toEqual(['--cap-add=NET_ADMIN']);
  });

  it('gives every finding a documentation link', () => {
    const container = makeContainer({
      privileged: true,
      networkMode: 'host',
      capAdd: ['NET_ADMIN'],
      user: '0',
      mounts: [
        { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Type: 'bind', RW: true },
        { Source: '/mnt/user', Destination: '/data', Type: 'bind', RW: true },
      ],
    });
    const findings = findingsFor(container, noPorts);
    expect(findings).toHaveLength(6);
    for (const finding of findings) {
      expect(finding.docs).toBe(DOCS[finding.type]);
      expect(finding.docs).toMatch(/^https:\/\/docs\.docker\.com\//);
    }
  });

  it('flags a writable mount of a broad path but not of a subfolder', () => {
    const broad = makeContainer({
      mounts: [{ Source: '/mnt/user', Destination: '/data', Type: 'bind', RW: true }],
    });
    expect(typesOf(broad)).toEqual(['broad-mount']);

    const narrow = makeContainer({
      mounts: [{ Source: '/mnt/user/appdata/app', Destination: '/data', Type: 'bind', RW: true }],
    });
    expect(typesOf(narrow)).toEqual([]);
  });

  it('suggests a narrower path and read-only access for a share mount', () => {
    const container = makeContainer({
      name: 'plex',
      mounts: [{ Source: '/mnt/user', Destination: '/media', Type: 'bind', RW: true }],
    });
    const [finding] = findingsFor(container, noPorts);
    expect(finding.fix).toContain('Narrowing Host Path is the real fix');
    expect(removals(finding)).toEqual(['/mnt/user -> /media (Read/Write)']);
    // A placeholder share, not a guessed one: a /media destination wants media,
    // not appdata, and only the user knows which share that is. The right column
    // carries the Host Path alone, because the container path does not change.
    expect(additions(finding)).toEqual(['/mnt/user/<share>']);
    expect(detailText(finding)).toContain('Name the one share');
  });

  it('says to remove a mount that cannot be narrowed', () => {
    const boot = makeContainer({
      mounts: [{ Source: '/boot', Destination: '/boot', Type: 'bind', RW: true }],
    });
    // Nothing to put back: a container has no business writing to the flash drive.
    expect(additions(findingsFor(boot, noPorts)[0])).toEqual([]);
    expect(detailText(findingsFor(boot, noPorts)[0])).toContain('flash drive');

    const root = makeContainer({
      mounts: [{ Source: '/', Destination: '/host', Type: 'bind', RW: true }],
    });
    expect(additions(findingsFor(root, noPorts)[0])).toEqual([]);
    expect(detailText(findingsFor(root, noPorts)[0])).toContain('whole filesystem');
  });

  it('advises on every offending mount in one finding', () => {
    const container = makeContainer({
      mounts: [
        { Source: '/mnt/user', Destination: '/media', Type: 'bind', RW: true },
        { Source: '/etc', Destination: '/host-etc', Type: 'bind', RW: true },
      ],
    });
    const findings = findingsFor(container, noPorts);
    // One finding, so one dismissal covers the container rather than one mount.
    expect(findings).toHaveLength(1);
    expect(removals(findings[0])).toEqual([
      '/mnt/user -> /media (Read/Write)',
      '/etc -> /host-etc (Read/Write)',
    ]);
    // /etc has no narrower path to suggest, so its right-hand column is empty.
    expect(additions(findings[0])).toEqual(['/mnt/user/<share>']);
  });

  it('calls a writable mount of /boot critical and /mnt only a warning', () => {
    const boot = makeContainer({
      mounts: [{ Source: '/boot', Destination: '/boot', Type: 'bind', RW: true }],
    });
    expect(findingsFor(boot, noPorts)[0].severity).toBe('critical');

    const mnt = makeContainer({
      mounts: [{ Source: '/mnt', Destination: '/mnt', Type: 'bind', RW: true }],
    });
    expect(findingsFor(mnt, noPorts)[0].severity).toBe('warning');
  });

  it('ignores a read-only mount of a broad path', () => {
    const container = makeContainer({
      mounts: [{ Source: '/mnt/user', Destination: '/data', Type: 'bind', RW: false }],
    });
    expect(typesOf(container)).toEqual([]);
  });

  it('flags a container pinned to root, and not one that left the user alone', () => {
    expect(typesOf(makeContainer({ user: '' }))).toEqual([]);
    expect(typesOf(makeContainer({ user: '1000:1000' }))).toEqual([]);

    const [finding] = findingsFor(makeContainer({ name: 'plex', user: '0' }), noPorts);
    expect(finding.type).toBe('forced-root');
    expect(finding.severity).toBe('warning');
    expect(removals(finding)).toEqual(['--user=0']);
    expect(additions(finding)).toEqual([]);
    expect(finding.fix).toContain('Edit plex in Unraid');
  });

  it('suggests a matching port for a host-network container', () => {
    const container = makeContainer({ networkMode: 'host', exposedPorts: ['8989/tcp'] });
    const [finding] = findingsFor(container, noPorts);
    expect(finding.type).toBe('host-network');
    expect(finding.detail).toEqual([
      { remove: 'Network Type: host', add: 'Network Type: bridge' },
      { add: '8989:8989', note: 'No other container is using 8989.' },
    ]);
  });

  it('steps past a port another container holds and names it', () => {
    const container = makeContainer({ networkMode: 'host', exposedPorts: ['3000/tcp'] });
    const bound: PortOwners = new Map([[3000, 'grafana']]);
    const [finding] = findingsFor(container, bound);
    expect(finding.detail).toEqual([
      { remove: 'Network Type: host', add: 'Network Type: bridge' },
      { add: '3001:3000', note: 'grafana is using 3000, so this moves up to 3001.' },
    ]);
  });

  it('keeps the protocol on a non-tcp port', () => {
    const container = makeContainer({ networkMode: 'host', exposedPorts: ['53/udp'] });
    const [finding] = findingsFor(container, noPorts);
    expect(additions(finding)).toEqual(['Network Type: bridge', '53:53/udp']);
  });

  it('summarizes once past four exposed ports', () => {
    const container = makeContainer({
      networkMode: 'host',
      exposedPorts: ['1/tcp', '2/tcp', '3/tcp', '4/tcp', '5/tcp', '6/tcp'],
    });
    const [finding] = findingsFor(container, noPorts);
    // One network row, four suggested ports, then the summary line.
    expect(finding.detail).toHaveLength(6);
    expect(finding.detail![5]).toEqual({ note: 'And 2 more exposed ports.' });
  });

  it('skips the number when the image declares no port', () => {
    const container = makeContainer({ networkMode: 'host', exposedPorts: [] });
    const [finding] = findingsFor(container, noPorts);
    expect(detailText(finding)).toContain('declares no ports');
  });

  it('returns critical findings before warnings', () => {
    const container = makeContainer({
      privileged: true,
      networkMode: 'host',
      capAdd: ['NET_ADMIN'],
      exposedPorts: ['8080/tcp'],
      mounts: [
        { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Type: 'bind', RW: true },
        { Source: '/', Destination: '/host', Type: 'bind', RW: true },
      ],
    });
    const findings = findingsFor(container, noPorts);
    expect(findings).toHaveLength(5);
    expect(findings.filter((f) => f.severity === 'critical')).toHaveLength(3);
    expect(findings.slice(0, 3).every((f) => f.severity === 'critical')).toBe(true);
  });
});
