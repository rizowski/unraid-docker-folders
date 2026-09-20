import { describe, it, expect } from 'vitest';
import {
  DOCS,
  FINDING_TYPES,
  describeUser,
  effectiveUser,
  findingsFor,
  mountWritersFor,
  pathIsWithin,
  pathsOverlap,
  blockedBy,
  describeUmask,
  folderConflicts,
  parseUmask,
  isForcedRoot,
  parseExposedPort,
  suggestHostPort,
  type FindingDetail,
  type PortOwners,
  type SecurityFinding,
} from '@/utils/securityFindings';
import { makeContainer } from '@/test/fixtures';

const noPorts: PortOwners = new Map();

const typesOf = (container: Parameters<typeof findingsFor>[0], bound = noPorts) =>
  findingsFor(container, bound).map((f) => f.type);


/** Detail rows flattened, for assertions that do not care about the columns. */
const detailText = (finding: SecurityFinding) =>
  (finding.detail ?? [])
    .map((d) => [d.remove, d.add, d.removeNote, d.addNote, d.note].filter(Boolean).join(' '))
    .join('\n');

/** The left column: what the advisor detected. */
const removals = (finding: SecurityFinding) =>
  (finding.detail ?? []).map((d) => d.remove).filter(Boolean);

/** The right column: what it recommends instead. */
const additions = (finding: SecurityFinding) =>
  (finding.detail ?? []).map((d) => d.add).filter(Boolean);

describe('FINDING_TYPES', () => {
  // The same strings are the write-side allowlist in
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
      'shared-mount-group',
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

  it('stays silent when the image is the one asking for root', () => {
    // Docker copies the image's USER into the container's Config.User, so uid 0
    // on a container built from grafana/mimir, which ships USER 0, means nobody
    // chose anything. Every such container read as forced-root before this.
    expect(isForcedRoot('0', '0')).toBe(false);
    expect(isForcedRoot('root', 'root')).toBe(false);
    // The two spellings mean the same user, so neither is an override.
    expect(isForcedRoot('root', '0')).toBe(false);
    expect(isForcedRoot('0', 'root')).toBe(false);
  });

  it('fires when the override disagrees with the image', () => {
    expect(isForcedRoot('0', '1000')).toBe(true);
    // No USER in the image, so uid 0 can only have come from outside it. This
    // is the case the finding was written for.
    expect(isForcedRoot('0', '')).toBe(true);
  });

  it('stays silent for a non-root user whatever the image asks', () => {
    expect(isForcedRoot('1000', '0')).toBe(false);
    expect(isForcedRoot('', '0')).toBe(false);
  });
});

describe('pathIsWithin', () => {
  it('counts a folder as within itself', () => {
    expect(pathIsWithin('/mnt/user/media', '/mnt/user/media')).toBe(true);
  });

  it('counts a child', () => {
    expect(pathIsWithin('/mnt/user/media/tv', '/mnt/user/media')).toBe(true);
  });

  it('does not count a sibling that merely shares a prefix', () => {
    // The containment bug CLAUDE.md calls out on the PHP side. Without the
    // trailing separator this passes and the advisor invents a conflict.
    expect(pathIsWithin('/mnt/user/media-old', '/mnt/user/media')).toBe(false);
  });

  it('tolerates a trailing slash on the parent', () => {
    expect(pathIsWithin('/mnt/user/media/tv', '/mnt/user/media/')).toBe(true);
  });

  it('is false for an empty path', () => {
    expect(pathIsWithin('', '/mnt')).toBe(false);
    expect(pathIsWithin('/mnt', '')).toBe(false);
  });

  it('overlaps in either direction', () => {
    expect(pathsOverlap('/mnt/user/media', '/mnt/user/media/tv')).toBe(true);
    expect(pathsOverlap('/mnt/user/media/tv', '/mnt/user/media')).toBe(true);
    expect(pathsOverlap('/mnt/user/media', '/mnt/user/books')).toBe(false);
  });
});

describe('effectiveUser', () => {
  it('says nothing when the container says nothing', () => {
    // The common case: no --user, no PUID. The image picks, and we cannot know.
    expect(effectiveUser(makeContainer())).toBeNull();
  });

  it('reads PUID and PGID', () => {
    const c = makeContainer({ puid: '1000', pgid: '100' });
    expect(effectiveUser(c)).toEqual({ uid: '1000', gid: '100', field: 'puid' });
  });

  it('keeps PUID when PGID is missing', () => {
    expect(effectiveUser(makeContainer({ puid: '99' }))).toEqual({
      uid: '99',
      gid: null,
      field: 'puid',
    });
  });

  it('prefers an explicit user over PUID, because Docker applies it', () => {
    const c = makeContainer({ user: '0', puid: '1000', pgid: '1000' });
    expect(effectiveUser(c)).toEqual({ uid: '0', gid: null, field: 'user' });
  });

  it('resolves root to 0', () => {
    expect(effectiveUser(makeContainer({ user: 'root' }))?.uid).toBe('0');
    expect(effectiveUser(makeContainer({ user: 'root:root' }))).toEqual({
      uid: '0',
      gid: null,
      field: 'user',
    });
  });

  it('gives up on a user name, rather than guess a number for it', () => {
    // Only the host passwd file maps abc to a uid. Comparing a name against a
    // number would invent a mismatch that may not exist.
    expect(effectiveUser(makeContainer({ user: 'abc' }))).toBeNull();
    expect(effectiveUser(makeContainer({ puid: 'abc' }))).toBeNull();
  });

  it('describes itself the way the setting is spelled', () => {
    expect(describeUser({ uid: '99', gid: '100', field: 'puid' })).toBe('PUID 99, PGID 100');
    expect(describeUser({ uid: '99', gid: null, field: 'puid' })).toBe('PUID 99');
    expect(describeUser({ uid: '0', gid: null, field: 'user' })).toBe('--user=0');
    expect(describeUser({ uid: '0', gid: '0', field: 'user' })).toBe('--user=0:0');
  });
});

describe('parseUmask', () => {
  it('reads an octal umask', () => {
    expect(parseUmask('022')).toBe(0o022);
    expect(parseUmask('002')).toBe(0o002);
    expect(parseUmask('000')).toBe(0);
    expect(parseUmask('0002')).toBe(0o002);
  });

  it('rejects anything that is not octal', () => {
    expect(parseUmask('')).toBeNull();
    expect(parseUmask('abc')).toBeNull();
    expect(parseUmask('088')).toBeNull();
    expect(parseUmask('7777')).toBeNull();
  });

  it('prints back the way a person writes it', () => {
    expect(describeUmask(0o022)).toBe('022');
    expect(describeUmask(0)).toBe('000');
  });
});

describe('blockedBy', () => {
  const writer = (uid: string, gid: string | null, umask: number) =>
    ({
      container: `c${uid}${gid}`,
      source: '/mnt/user/media',
      user: { uid, gid, field: 'puid' as const },
      umask,
      umaskStated: true,
    });

  it('never blocks the same user, whatever the umask', () => {
    expect(blockedBy(writer('99', '100', 0o077), writer('99', '1000', 0o077))).toBeNull();
  });

  it('blocks the group when the umask takes group write away', () => {
    // 0666 & ~022 = 0644. Same group, but the group cannot write.
    expect(blockedBy(writer('99', '100', 0o022), writer('1000', '100', 0o022))).toBe('group');
  });

  it('lets the group through when the umask keeps group write', () => {
    // 0666 & ~002 = 0664.
    expect(blockedBy(writer('99', '100', 0o002), writer('1000', '100', 0o022))).toBeNull();
  });

  it('blocks a different group under the usual umask', () => {
    expect(blockedBy(writer('99', '100', 0o022), writer('1000', '1000', 0o022))).toBe('other');
  });

  it('lets a different group through when everything is writable', () => {
    // 0666 & ~000 = 0666, which is why UMASK=000 is the usual Unraid advice.
    expect(blockedBy(writer('99', '100', 0), writer('1000', '1000', 0o022))).toBeNull();
  });

  it('says nothing when either side states no group', () => {
    expect(blockedBy(writer('99', null, 0o022), writer('1000', '100', 0o022))).toBeNull();
    expect(blockedBy(writer('99', '100', 0o022), writer('1000', null, 0o022))).toBeNull();
  });
});

describe('shared folder, different group', () => {
  const mount = (Source: string, RW = true) => ({
    Source,
    Destination: '/data',
    Type: 'bind',
    RW,
  });

  const plex = makeContainer({
    id: 'p',
    name: 'plex',
    puid: '99',
    pgid: '100',
    mounts: [mount('/mnt/user/media')],
  });

  const sab = makeContainer({
    id: 's',
    name: 'sabnzbd',
    puid: '1000',
    pgid: '1000',
    mounts: [mount('/mnt/user/media/downloads')],
  });

  const writersOf = (...cs: ReturnType<typeof makeContainer>[]) => cs.flatMap(mountWritersFor);

  /** The shared-folder finding alone. A fixture can trip other rules too. */
  const sharedFinding = (
    container: ReturnType<typeof makeContainer>,
    writers: Parameters<typeof findingsFor>[2],
  ) => findingsFor(container, noPorts, writers).find((f) => f.type === 'shared-mount-group');

  it('fires on a nested path and names the shared folder', () => {
    const finding = sharedFinding(plex, writersOf(plex, sab))!;
    expect(finding.severity).toBe('warning');
    // The deeper mount is the folder they genuinely share; plex reaches it
    // through its parent.
    expect(detailText(finding)).toContain(
      '/mnt/user/media/downloads, written as PUID 99, PGID 100, umask 022 assumed',
    );
    expect(detailText(finding)).toContain('under a different group');
  });

  it('fires on both containers, from each side', () => {
    const writers = writersOf(plex, sab);
    expect(detailText(sharedFinding(sab, writers)!)).toContain(
      '/mnt/user/media/downloads, written as PUID 1000, PGID 1000, umask 022 assumed',
    );
  });

  it('fires on an identical path', () => {
    const other = makeContainer({
      id: 'o',
      name: 'other',
      puid: '1000',
      pgid: '1000',
      mounts: [mount('/mnt/user/media')],
    });
    expect(sharedFinding(plex, writersOf(plex, other))).toBeDefined();
  });

  it('reports the effect and names no setting to change', () => {
    // Which identity the folder belongs to depends on every other folder these
    // containers write, which this plugin cannot see. A number here would send
    // a share of users the wrong way, so the finding states the effect only.
    const finding = sharedFinding(plex, writersOf(plex, sab))!;
    expect(additions(finding)).toEqual([]);
    expect(removals(finding)).toEqual([]);

    // "PGID 100" is allowed as a detected identity, so the directives are the
    // phrases that told the user to go and set one.
    const words = `${finding.fix} ${detailText(finding)}`;
    for (const directive of ['UMASK=002', 'Set UMASK', 'Give every', 'same PUID', 'one PGID']) {
      expect(words).not.toContain(directive);
    }
    expect(finding.fix).toContain('fail to read or change');
  });

  it('reads an explicit --user as the identity', () => {
    const rooted = makeContainer({
      id: 'r',
      name: 'rooted',
      user: '0:0',
      mounts: [mount('/mnt/user/media')],
    });
    const finding = sharedFinding(rooted, writersOf(rooted, sab))!;
    expect(detailText(finding)).toContain(
      '/mnt/user/media/downloads, written as --user=0:0, umask 022 assumed',
    );
  });

  it('stays quiet when the users match, whatever the groups are', () => {
    // Same user means the owner bits apply, which are always writable.
    const twin = makeContainer({
      id: 't',
      name: 'twin',
      puid: '99',
      pgid: '1000',
      mounts: [mount('/mnt/user/media/tv')],
    });
    expect(sharedFinding(plex, writersOf(plex, twin))).toBeUndefined();
  });

  it('stays quiet when a shared group can write, thanks to the umask', () => {
    const relaxed = makeContainer({
      id: 'rx',
      name: 'relaxed',
      puid: '99',
      pgid: '100',
      umask: '002',
      mounts: [mount('/mnt/user/books')],
    });
    const peer = makeContainer({
      id: 'px',
      name: 'peer',
      puid: '1000',
      pgid: '100',
      umask: '002',
      mounts: [mount('/mnt/user/books')],
    });
    expect(sharedFinding(relaxed, writersOf(relaxed, peer))).toBeUndefined();
  });

  it('stays quiet when either side states no group', () => {
    const noGroup = makeContainer({
      id: 'u',
      name: 'nogroup',
      puid: '1000',
      mounts: [mount('/mnt/user/media/tv')],
    });
    expect(sharedFinding(plex, writersOf(plex, noGroup))).toBeUndefined();

    const bare = makeContainer({ id: 'b', name: 'bare', mounts: [mount('/mnt/user/media')] });
    expect(sharedFinding(bare, writersOf(bare, sab))).toBeUndefined();
  });

  it('stays quiet when a mount is read-only', () => {
    const reader = makeContainer({
      id: 'r2',
      name: 'reader',
      puid: '1000',
      pgid: '1000',
      mounts: [mount('/mnt/user/media/tv', false)],
    });
    expect(sharedFinding(plex, writersOf(plex, reader))).toBeUndefined();
  });

  it('stays quiet about folders that do not overlap', () => {
    const books = makeContainer({
      id: 'k',
      name: 'books',
      puid: '1000',
      pgid: '1000',
      mounts: [mount('/mnt/user/books')],
    });
    expect(sharedFinding(plex, writersOf(plex, books))).toBeUndefined();
  });

  it('ignores a broad mount, which would otherwise pair with everything', () => {
    // A container holding /mnt/user contains every other container's folders.
    // Pairing it with all of them buries the real conflicts, and broad-mount
    // already tells this container to narrow the mount.
    const wide = makeContainer({
      id: 'w',
      name: 'wide',
      puid: '99',
      pgid: '100',
      mounts: [mount('/mnt/user')],
    });
    expect(sharedFinding(wide, writersOf(wide, sab))).toBeUndefined();
    expect(sharedFinding(sab, writersOf(wide, sab))).toBeUndefined();

    // The broad mount still gets its own finding, so nothing goes unreported.
    expect(findingsFor(wide, noPorts, writersOf(wide, sab)).map((f) => f.type)).toEqual([
      'broad-mount',
    ]);
  });

  it('does not report a container against itself', () => {
    // Two mounts of one tree on one container is one group, not two.
    const solo = makeContainer({
      id: 'x',
      name: 'solo',
      puid: '99',
      pgid: '100',
      mounts: [mount('/mnt/user/media'), mount('/mnt/user/media/tv')],
    });
    expect(sharedFinding(solo, writersOf(solo))).toBeUndefined();
  });

  it('summarizes past four shared folders', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const many = makeContainer({
      id: 'm',
      name: 'many',
      puid: '99',
      pgid: '100',
      mounts: names.map((n) => mount(`/mnt/user/${n}`)),
    });
    const peer = makeContainer({
      id: 'q',
      name: 'peer',
      puid: '1000',
      pgid: '1000',
      mounts: names.map((n) => mount(`/mnt/user/${n}`)),
    });
    const finding = sharedFinding(many, writersOf(many, peer))!;
    expect(finding.detail).toHaveLength(5);
    expect(finding.detail![4]).toEqual({ note: 'And 1 more shared folder.' });
  });

  it('groups by folder, so one clash is one row, not one per container', () => {
    const rows = folderConflicts(writersOf(plex, sab));
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('/mnt/user/media/downloads');
    expect(rows[0].writers.map((w) => w.container).sort()).toEqual(['plex', 'sabnzbd']);
    expect(rows[0].reason).toBe('other');
  });

  it('keeps a third container on the same folder row', () => {
    const third = makeContainer({
      id: 'z',
      name: 'radarr',
      puid: '500',
      pgid: '500',
      mounts: [mount('/mnt/user/media/downloads')],
    });
    const rows = folderConflicts(writersOf(plex, sab, third));
    const downloads = rows.find((r) => r.path === '/mnt/user/media/downloads')!;
    expect(downloads.writers.map((w) => w.container).sort()).toEqual([
      'plex',
      'radarr',
      'sabnzbd',
    ]);
  });

  it('flags a shared group when the umask leaves files read-only to it', () => {
    // The case a group-only rule misses: one group, different users, 0644.
    const a = makeContainer({
      id: 'ua',
      name: 'sonarr',
      puid: '99',
      pgid: '100',
      umask: '022',
      mounts: [mount('/mnt/user/media/tv')],
    });
    const b = makeContainer({
      id: 'ub',
      name: 'radarr',
      puid: '1000',
      pgid: '100',
      mounts: [mount('/mnt/user/media/tv')],
    });
    const rows = folderConflicts(writersOf(a, b));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('group');

    const finding = sharedFinding(a, writersOf(a, b))!;
    expect(detailText(finding)).toContain('leaves them read-only to the rest of that group');
    // Same-group clashes get the same treatment: the effect, not a umask value.
    expect(additions(finding)).toEqual([]);
    expect(finding.fix).not.toContain('UMASK');
  });

  it('stays quiet when the creator makes everything writable', () => {
    // UMASK=000 is the usual Unraid fix, and it genuinely settles the problem.
    const open = makeContainer({
      id: 'o1',
      name: 'open',
      puid: '99',
      pgid: '100',
      umask: '000',
      mounts: [mount('/mnt/user/media/downloads')],
    });
    const other = makeContainer({
      id: 'o2',
      name: 'other',
      puid: '1000',
      pgid: '1000',
      umask: '000',
      mounts: [mount('/mnt/user/media/downloads')],
    });
    expect(folderConflicts(writersOf(open, other))).toEqual([]);
  });

  it('says when a umask was assumed rather than stated', () => {
    const finding = sharedFinding(plex, writersOf(plex, sab))!;
    expect(detailText(finding)).toContain('umask 022 assumed');
  });

  it('links to the page that explains PGID, not to Docker', () => {
    const finding = sharedFinding(plex, writersOf(plex, sab))!;
    expect(finding.docs).toBe('https://docs.linuxserver.io/general/understanding-puid-and-pgid/');
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
    // ALL is the only capability row that also carries a replacement, so it is
    // the row where a rule that guessed the side from the replacement put the
    // note on the wrong cell. The note explains the capability that is set.
    expect(finding.detail?.[0].removeNote).toContain('ALL grants every capability');
    expect(finding.detail?.[0].addNote).toBeUndefined();
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
    expect(finding.fix).toContain('the smallest folder the application needs');
    expect(removals(finding)).toEqual(['/mnt/user -> /media (Read/Write)']);
    // A placeholder share, not a guessed one: a /media destination wants media,
    // not appdata, and only the user knows which share that is. The right column
    // carries the Host Path alone, because the container path does not change.
    expect(additions(finding)).toEqual(['/mnt/user/<share>']);
    // The note describes the mount that was found, so it sits on the detected
    // cell. Beside the suggestion it would read as a complaint about the
    // suggestion.
    expect(finding.detail?.[0].removeNote).toContain('Covers every share on the array');
    expect(finding.detail?.[0].addNote).toBeUndefined();
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
    expect(detailText(findingsFor(root, noPorts)[0])).toContain('Covers the whole server');
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

  it('leaves a container alone when its image is what asks for root', () => {
    // grafana/mimir, reported from a compose stack that sets no user at all.
    const mimir = makeContainer({ name: 'mimir', user: '0', imageUser: '0' });
    expect(typesOf(mimir)).toEqual([]);
  });

  it('suggests a matching port for a host-network container', () => {
    const container = makeContainer({ networkMode: 'host', exposedPorts: ['8989/tcp'] });
    const [finding] = findingsFor(container, noPorts);
    expect(finding.type).toBe('host-network');
    expect(finding.detail).toEqual([
      { remove: 'Network Type: host', add: 'Network Type: bridge' },
      { add: '8989:8989', addNote: 'No other container is using 8989.' },
    ]);
  });

  it('steps past a port another container holds and names it', () => {
    const container = makeContainer({ networkMode: 'host', exposedPorts: ['3000/tcp'] });
    const bound: PortOwners = new Map([[3000, 'grafana']]);
    const [finding] = findingsFor(container, bound);
    expect(finding.detail).toEqual([
      { remove: 'Network Type: host', add: 'Network Type: bridge' },
      { add: '3001:3000', addNote: 'grafana is using 3000, so this moves up to 3001.' },
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

describe('detail rows put every note on a cell', () => {
  /**
   * The panel draws a row either as two cells or as one plain note, never as
   * both. A row that carries a cell and a plain `note` therefore loses the note
   * with no error anywhere, which is the one way this shape can fail quietly.
   * Walking every rule catches it at the rule that introduces it, rather than
   * leaving somebody to notice a missing tooltip in the browser.
   */
  const everyFinding = () => {
    const root = makeContainer({
      name: 'everything',
      privileged: true,
      networkMode: 'host',
      user: 'root',
      capAdd: ['ALL', 'NET_ADMIN', 'AUDIT_WRITE'],
      exposedPorts: ['80/tcp', '443/tcp', '53/udp', '8080/tcp', '9000/tcp', '9001/tcp'],
      mounts: [
        { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Type: 'bind', RW: true },
        { Source: '/mnt/user', Destination: '/media', Type: 'bind', RW: true },
      ],
    });
    // Read-only takes the socket finding's other branch, which is the only
    // note in the set written as a ternary.
    const readOnlySocket = makeContainer({
      name: 'ro-socket',
      mounts: [
        { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Type: 'bind', RW: false },
      ],
    });
    const plex = makeContainer({
      name: 'plex',
      puid: '99',
      pgid: '100',
      mounts: [{ Source: '/mnt/user/media', Destination: '/media', Type: 'bind', RW: true }],
    });
    const sab = makeContainer({
      name: 'sab',
      puid: '1000',
      pgid: '1000',
      mounts: [{ Source: '/mnt/user/media/dl', Destination: '/dl', Type: 'bind', RW: true }],
    });
    const writers = [plex, sab].flatMap(mountWritersFor);
    return [
      ...findingsFor(root, noPorts),
      ...findingsFor(readOnlySocket, noPorts),
      ...findingsFor(plex, noPorts, writers),
    ];
  };

  it('covers every finding type', () => {
    const seen = new Set(everyFinding().map((f) => f.type));
    expect([...seen].sort()).toEqual([...FINDING_TYPES].sort());
  });

  // Collected rather than asserted row by row, so a failure names the rule and
  // the note that went astray instead of pointing at a loop.
  const offenders = (bad: (row: FindingDetail) => boolean) =>
    everyFinding().flatMap((finding) =>
      (finding.detail ?? [])
        .filter(bad)
        .map((row) => `${finding.type}: ${row.note ?? row.removeNote ?? row.addNote}`),
    );

  it('never puts a plain note on a row that has cells', () => {
    expect(offenders((row) => Boolean((row.remove || row.add) && row.note))).toEqual([]);
  });

  it('never leaves a cell note on a row without that cell', () => {
    // A note about the replacement, on a row with no replacement to show, would
    // hang the icon on the word "removal".
    expect(
      offenders((row) => Boolean((row.removeNote && !row.remove) || (row.addNote && !row.add))),
    ).toEqual([]);
  });
});
