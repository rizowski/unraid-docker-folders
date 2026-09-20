/**
 * Security advisor rules.
 *
 * Pure functions over fields the container list already carries, so the whole
 * rule set is testable without a store, a fetch, or a Docker socket. Nothing
 * here talks to Unraid: every finding tells the user what to change in Unraid's
 * own Docker edit form, and the plugin never touches the container.
 *
 * Findings are for running containers only (the caller decides), but port
 * occupancy is built from every container — a stopped one still owns its
 * binding and takes the port back the moment it starts.
 */

import type { Container, ContainerMount } from '@/stores/docker';

/**
 * Every finding type, as the one runtime list the union is derived from.
 *
 * `SecurityAdvisor::FINDING_TYPES` in the backend repeats these strings as its
 * write-side allowlist, because PHP and TypeScript share no source. Add a type
 * to both, or a dismissal of the new type comes back as a 400.
 */
export const FINDING_TYPES = [
  'privileged',
  'docker-socket',
  'host-network',
  'added-capabilities',
  'broad-mount',
  'forced-root',
  'shared-mount-group',
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];

export type Severity = 'critical' | 'warning';

/**
 * One row of the remove/add table: the setting as it stands now, what to put in
 * its place, and why. Either side can be empty. A port mapping is an addition
 * with nothing to remove, and a capability the application never needed is a
 * removal with nothing to add.
 *
 * The note is separate from both so it renders as prose. A paragraph of
 * monospace explanation reads like command output, not like guidance.
 *
 * The panel hangs a note on a cell as an info icon, so each note names the cell
 * it belongs to rather than leaving the panel to work it out. The side is not
 * cosmetic: "Covers every share on the array" beside /mnt/user/<share> reads as
 * a complaint about the suggestion, when it describes the mount that is there
 * today. A row with no cells at all, such as "And 3 more exposed ports", uses
 * the plain `note`, which renders as its own line.
 *
 * A row must not carry cells and a plain `note` together. The panel renders one
 * or the other, so the note would vanish. A test walks every rule to hold that.
 */
export interface FindingDetail {
  /** The current setting, as Unraid or `docker run` spells it. */
  remove?: string;
  /** What to put in its place. */
  add?: string;
  /** One line on why the detected setting is a problem. */
  removeNote?: string;
  /** One line on why this replacement, for this row only. */
  addNote?: string;
  /** A summary line standing on its own, for a row with neither cell. */
  note?: string;
}

export interface SecurityFinding {
  type: FindingType;
  severity: Severity;
  /** Short label, used in the badge tooltip and as the modal row heading. */
  title: string;
  /** One sentence on what the setting actually grants. */
  why: string;
  /** What to change, written for Unraid's Docker edit form. */
  fix: string;
  /** The offending mounts, capabilities, or suggested port mappings. */
  detail?: FindingDetail[];
  /** Docker's own documentation for the setting. */
  docs: string;
}

/**
 * A finding as a rule states it. The documentation link is left off because it
 * follows from the type, and `findingsFor` stamps it on: six builders each
 * picking their own DOCS key by hand is six chances to paste the wrong one.
 */
type FindingRule = Omit<SecurityFinding, 'docs'>;

/**
 * Where each setting is documented. Every anchor here was checked against the
 * live page: the `docker container run` reference anchors only some options, so
 * `--cap-add` and `--user` point at pages that cover the subject properly
 * rather than at an anchor that silently lands at the top.
 */
export const DOCS: Record<FindingType, string> = {
  privileged: 'https://docs.docker.com/reference/cli/docker/container/run/#privileged',
  'docker-socket': 'https://docs.docker.com/engine/security/#docker-daemon-attack-surface',
  'host-network': 'https://docs.docker.com/engine/network/drivers/host/',
  'added-capabilities': 'https://docs.docker.com/engine/security/#linux-kernel-capabilities',
  'broad-mount': 'https://docs.docker.com/engine/storage/bind-mounts/',
  'forced-root': 'https://docs.docker.com/engine/security/userns-remap/',
  // Not a Docker page. PUID and PGID are a linuxserver.io convention, and this
  // page is the one that explains what they do to the ownership of files in a
  // shared volume. The modal derives its link label from the host.
  'shared-mount-group': 'https://docs.linuxserver.io/general/understanding-puid-and-pgid/',
};

/** Host port -> name of a container that binds it. */
export type PortOwners = Map<number, string>;

export const DOCKER_SOCKET = '/var/run/docker.sock';

/**
 * Writable bind mounts of these host paths hand a container the whole array,
 * the flash drive, or the host's own configuration. Matched exactly: a mount of
 * /mnt/user/appdata/sonarr is normal and must not be flagged.
 */
export const BROAD_PATHS = ['/', '/boot', '/etc', '/var/run', '/mnt', '/mnt/user'];

/** Broad paths where a writable mount is bad enough to call critical. */
const CRITICAL_PATHS = ['/', '/boot'];

/**
 * What to do about each broad path. A narrower Host Path comes first, because
 * it is the change that actually reduces what the container can reach.
 * Read-only access is the fallback for a container that has to see the wider
 * tree. The paths that no container should mount say to remove the mount
 * instead of offering a narrower spelling of the same thing.
 */
interface MountAdvice {
  /** A narrower Host Path to suggest. Absent means the mount should just go. */
  path?: string;
  note: string;
}

/**
 * /mnt and /mnt/user get the same answer, because both are the array and the
 * fix for both is to name one share. The share is deliberately a placeholder:
 * which one this container wants is only knowable from the destination and the
 * application, so guessing it would put a wrong path in a column the user
 * pastes from.
 */
const SHARE_ADVICE: MountAdvice = {
  path: '/mnt/user/<share>',
  note: 'Covers every share on the array. Name the one the application uses.',
};

const BROAD_PATH_ADVICE: Record<string, MountAdvice> = {
  '/': { note: 'Covers the whole server. Mount the folders the application uses instead.' },
  '/boot': {
    note: 'The flash drive that holds the server configuration. Writing here can stop the server from booting.',
  },
  '/etc': { note: 'The server configuration files. Name the one file it reads, or remove the mount.' },
  '/var/run': {
    note: 'The server sockets, including the Docker socket. Name the one it needs, or remove the mount.',
  },
  '/mnt': SHARE_ADVICE,
  '/mnt/user': SHARE_ADVICE,
};

/**
 * Capabilities that are close enough to privileged mode to rank with it.
 * SYS_ADMIN alone is enough to mount filesystems and escape most containers.
 */
export const HIGH_RISK_CAPS = ['SYS_ADMIN', 'SYS_MODULE', 'ALL'];

/** Suggested port mappings printed before the list is summarized. */
export const MAX_SUGGESTED_PORTS = 4;

/**
 * Whether the container was pinned to root on purpose.
 *
 * An empty user is the normal case and says nothing: the image picks the user,
 * and images from linuxserver.io, along with official ones such as postgres and
 * nginx, all start as root and drop privileges at entrypoint. Only a value set
 * in the template means somebody chose root, so that is the only case worth a
 * finding.
 */
export function isForcedRoot(user: string): boolean {
  const [uid] = String(user ?? '').trim().split(':');
  return uid === '0' || uid.toLowerCase() === 'root';
}

/**
 * Whether `child` sits inside `parent`, or is `parent`.
 *
 * Anchored on a trailing separator. A plain `startsWith` is the containment bug
 * CLAUDE.md calls out on the PHP side: without the separator,
 * `/mnt/user/media-old` reads as inside `/mnt/user/media`.
 */
export function pathIsWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}

/** Whether two mounts reach the same files, in either direction. */
export function pathsOverlap(a: string, b: string): boolean {
  return pathIsWithin(a, b) || pathIsWithin(b, a);
}

/** A resolved container identity. `field` names the setting that produced it. */
export interface EffectiveUser {
  uid: string;
  gid: string | null;
  field: 'user' | 'puid';
}

const numeric = (value: string) => /^\d+$/.test(value);

/**
 * Who the container's files end up belonging to, or null when it does not say.
 *
 * `Config.User` wins when it is set, because Docker applies it directly. Almost
 * nothing sets it, so PUID and PGID carry the answer on Unraid: images from
 * linuxserver.io start as root and drop to them at entrypoint.
 *
 * A user *name* resolves to null. Only the host's passwd file maps it to a
 * number, and comparing a name against a number would invent a mismatch that
 * may not exist. `root` is the exception, because it is always 0.
 */
export function effectiveUser(container: Container): EffectiveUser | null {
  const configured = String(container.user ?? '').trim();
  if (configured) {
    const [rawUid, rawGid] = configured.split(':');
    const uid = rawUid?.toLowerCase() === 'root' ? '0' : rawUid;
    if (!uid || !numeric(uid)) return null;
    return { uid, gid: rawGid && numeric(rawGid) ? rawGid : null, field: 'user' };
  }

  const puid = String(container.puid ?? '').trim();
  if (!numeric(puid)) return null;
  const pgid = String(container.pgid ?? '').trim();
  return { uid: puid, gid: numeric(pgid) ? pgid : null, field: 'puid' };
}

/** How a resolved identity reads in the panel. */
export function describeUser(user: EffectiveUser): string {
  if (user.field === 'user') {
    return user.gid ? `--user=${user.uid}:${user.gid}` : `--user=${user.uid}`;
  }
  return user.gid ? `PUID ${user.uid}, PGID ${user.gid}` : `PUID ${user.uid}`;
}

/**
 * The umask every process starts with unless something changes it, and what a
 * linuxserver.io image uses when the template sets no UMASK.
 */
export const DEFAULT_UMASK = 0o022;

/** Read an octal umask string such as "022" or "0002". Null if it is not one. */
export function parseUmask(value: string): number | null {
  const raw = String(value ?? '').trim();
  if (!/^[0-7]{1,4}$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 8);
  return parsed <= 0o777 ? parsed : null;
}

/** Three-digit octal, the way a person writes a umask. */
export function describeUmask(umask: number): string {
  return umask.toString(8).padStart(3, '0');
}

/**
 * Split Docker's "8989/tcp" exposed-port form. Returns null for anything that
 * does not carry a positive port number.
 */
export function parseExposedPort(spec: string): { port: number; proto: string } | null {
  const [portPart, protoPart] = String(spec).split('/');
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { port, proto: protoPart || 'tcp' };
}

/**
 * Pick a host port to suggest for a container port.
 *
 * Returns the container port itself when no other container holds it, else the
 * next free port above it plus the name of the container holding the original.
 * `self` is the container being advised: a host-network container holds its own
 * exposed ports, and telling it that it conflicts with itself is nonsense.
 *
 * Ports the Unraid host itself holds (webgui, SSH, SMB) are invisible here,
 * which is why callers say "no other container is using X" and never "X is
 * free".
 */
export function suggestHostPort(
  exposed: number,
  bound: PortOwners,
  self = '',
): { port: number; takenBy: string | null } {
  const heldBy = (port: number) => {
    const owner = bound.get(port);
    return owner === undefined || owner === self ? null : owner;
  };

  const takenBy = heldBy(exposed);
  if (takenBy === null) return { port: exposed, takenBy: null };

  let candidate = exposed + 1;
  while (candidate < 65536 && heldBy(candidate) !== null) candidate++;
  return { port: candidate, takenBy };
}

/**
 * What to do about a given capability instead of just deleting the flag.
 *
 * Only ALL has a replacement, because naming one capability in place of every
 * capability is a real narrowing. Every other row leaves the right column
 * empty on purpose. `--cap-drop=ALL --cap-add=<the same capability>` looks like
 * hardening and is not: it keeps the dangerous capability and removes Docker's
 * fourteen defaults, which images from linuxserver.io need to drop from root to
 * PUID and PGID at startup. The container breaks and gains nothing.
 */
interface CapAdvice {
  /** What replaces the flag. Absent means the flag simply goes. */
  add?: string;
  note: string;
}

const CAP_ADVICE: Record<string, CapAdvice> = {
  ALL: {
    add: '--cap-add=<capability>',
    note: 'ALL grants every capability, which is privileged mode by another name. Name the one or two the application documents.',
  },
  SYS_ADMIN: {
    // No replacement. SYS_ADMIN is the capability that gets a process out of
    // the container, so nothing smaller stands in for it, and no device does
    // either: on Unraid a container mounts as real root, so a FUSE tool needs
    // the capability as well as /dev/fuse.
    note: 'SYS_ADMIN covers most of what privileged mode does and has no narrower substitute. If the container genuinely mounts a FUSE filesystem, for example rclone or mergerfs, it needs --device=/dev/fuse as well as the capability, and the only real fix is an image that does not ask for either.',
  },
  SYS_MODULE: {
    note: 'SYS_MODULE lets the container load kernel modules into the host kernel, which ends container isolation. Almost nothing needs it.',
  },
  NET_ADMIN: {
    note: 'NET_ADMIN covers routing, firewall rules, and interface changes. If the container runs a VPN tunnel, it also needs --device=/dev/net/tun. If it only sends pings, NET_RAW covers that and is already on by default.',
  },
  NET_RAW: {
    note: 'NET_RAW is in Docker’s default set already, so adding it changes nothing.',
  },
  SYS_PTRACE: {
    note: 'SYS_PTRACE lets the container inspect other processes. It belongs in a debugging session, not in a container that runs all the time.',
  },
  DAC_READ_SEARCH: {
    note: 'DAC_READ_SEARCH skips file read permission checks, so the container reads any file it can reach through a mount. Narrow the mount instead.',
  },
};

function capabilityFinding(container: Container, capAdd: string[]): FindingRule {
  const caps = capAdd.map((c) => c.toUpperCase().replace(/^CAP_/, ''));
  const high = caps.filter((c) => HIGH_RISK_CAPS.includes(c));

  const lines = caps.map((c) => {
    const advice = CAP_ADVICE[c];
    return {
      remove: `--cap-add=${c}`,
      // An unknown capability gets no replacement. There is no safer spelling
      // of a capability, so the decision is remove it or accept it.
      add: advice?.add,
      // Every capability note explains the capability that is set, including
      // ALL, which is the only row here that also has a replacement.
      removeNote: advice?.note,
    };
  });

  return {
    type: 'added-capabilities',
    severity: high.length > 0 ? 'critical' : 'warning',
    title: high.length > 0 ? `Grants ${high.join(', ')}` : 'Adds Linux capabilities',
    why:
      high.length > 0
        ? 'These capabilities let the container mount filesystems and load kernel modules, which is a route out of the container onto the host.'
        : 'Each added capability lifts one of the limits Docker puts on a container by default.',
    // Removal is the whole adjustment. Anything that reads like a safer
    // spelling of the same capability is false comfort.
    fix: `Edit ${container.name} in Unraid, open Show more settings, and take the flag out of Extra Parameters. Start the container and watch the log: templates often carry a capability the application never asks for. If it does need it, the flag stays and the risk stays with it.`,
    detail: lines,
  };
}

function socketMountFinding(mount: ContainerMount): FindingRule {
  const readOnly = !mount.RW;
  return {
    type: 'docker-socket',
    severity: 'critical',
    title: 'Mounts the Docker socket',
    why: 'Access to the Docker socket is access to the host: anything that can talk to it can start a privileged container and read every file on the array.',
    fix: readOnly
      ? 'Remove the mount if the application does not need it. Read-only stops nothing on its own, because the socket takes commands over the same channel it answers on. If the application genuinely needs Docker, put a socket proxy in front that exposes only the endpoints it uses.'
      : 'Remove the mount if the application does not need it. If it does, put a socket proxy in front that exposes only the endpoints it uses.',
    detail: [
      {
        remove: `${DOCKER_SOCKET} -> ${mount.Destination} (${readOnly ? 'Read Only' : 'Read/Write'})`,
        removeNote: readOnly
          ? 'Read-only changes nothing here, because the socket takes commands over the same channel it answers on.'
          : undefined,
      },
    ],
  };
}

function hostNetworkFinding(container: Container, bound: PortOwners): FindingRule {
  const exposed = (container.exposedPorts ?? [])
    .map(parseExposedPort)
    .filter((p): p is { port: number; proto: string } => p !== null)
    .sort((a, b) => a.port - b.port);

  const detail: FindingDetail[] = [
    { remove: 'Network Type: host', add: 'Network Type: bridge' },
  ];

  if (exposed.length === 0) {
    detail.push({
      note: 'The image declares no ports, so add a mapping for the port the application listens on, written as port:port.',
    });
  } else {
    const ports = exposed.slice(0, MAX_SUGGESTED_PORTS);
    for (const { port, proto } of ports) {
      const { port: hostPort, takenBy } = suggestHostPort(port, bound, container.name);
      detail.push({
        add: `${hostPort}:${port}${proto === 'tcp' ? '' : `/${proto}`}`,
        // This one is about the mapping being offered, not about host
        // networking, so it belongs beside the suggestion.
        addNote:
          takenBy === null
            ? `No other container is using ${hostPort}.`
            : `${takenBy} is using ${port}, so this moves up to ${hostPort}.`,
      });
    }
    const rest = exposed.length - ports.length;
    if (rest > 0) {
      detail.push({ note: `And ${rest} more exposed port${rest === 1 ? '' : 's'}.` });
    }
  }

  return {
    type: 'host-network',
    severity: 'warning',
    title: 'Uses host networking',
    why: 'The container shares the host network stack, so every port it opens is reachable on the server and it can see traffic meant for other containers.',
    fix: `Edit ${container.name} in Unraid and change the network, then add a port mapping for each port the application serves.`,
    detail,
  };
}

function broadMountFindings(container: Container): FindingRule[] {
  const offenders = (container.mounts ?? []).filter(
    (m) => m.Type === 'bind' && m.RW && BROAD_PATHS.includes(m.Source),
  );
  if (offenders.length === 0) return [];

  const critical = offenders.some((m) => CRITICAL_PATHS.includes(m.Source));

  return [
    {
      type: 'broad-mount',
      severity: critical ? 'critical' : 'warning',
      title: 'Writable mount of a broad host path',
      why: 'Host Path is a top level of the server, so the container can change every file under it. A container only needs the smallest folder it works on.',
      fix: `Edit ${container.name} in Unraid and change the volume mapping. Point Host Path at the smallest folder the application needs, such as one share, or set Access Mode to Read Only.`,
      detail: offenders.map((m) => {
        const advice = BROAD_PATH_ADVICE[m.Source];
        return {
          remove: `${m.Source} -> ${m.Destination} (Read/Write)`,
          // Only the new Host Path. The container path is not changing, so
          // repeating it on the right makes the reader diff two strings to
          // find the one field that moved.
          add: advice?.path,
          // The note says what the mount reaches today, not what the narrower
          // path would, so it hangs on the detected cell.
          removeNote: advice?.note,
        };
      }),
    },
  ];
}

/**
 * One container's writable bind mount, with the identity behind it.
 *
 * A flat list rather than a map keyed by path, because two mounts can reach the
 * same files without spelling the same string. The caller builds it once over
 * every running container.
 */
export interface MountWriter {
  container: string;
  source: string;
  user: EffectiveUser;
  /** The umask this container creates files with. */
  umask: number;
  /** False when the umask is the assumed default rather than a stated UMASK. */
  umaskStated: boolean;
}

/** Shared folders printed before the list is summarized. */
export const MAX_SHARED_PATHS = 4;

/**
 * Every writable bind mount of a container, paired with who writes it.
 *
 * A broad path is left out. A container holding /mnt/user contains every other
 * container's folders, so it would pair with all of them and bury the specific
 * conflicts under a list of coincidences. That mount has its own finding, and
 * narrowing it, which is what that finding asks for, settles this one too.
 */
export function mountWritersFor(container: Container): MountWriter[] {
  const user = effectiveUser(container);
  if (!user) return [];

  const stated = parseUmask(String(container.umask ?? ''));

  return (container.mounts ?? [])
    .filter((m) => m.Type === 'bind' && m.RW && !BROAD_PATHS.includes(m.Source))
    .map((m) => ({
      container: container.name,
      source: m.Source,
      user,
      umask: stated ?? DEFAULT_UMASK,
      umaskStated: stated !== null,
    }));
}

/** Which permission bit keeps the other container out. */
export type BlockReason = 'group' | 'other';

/**
 * Why `other` cannot write a file `creator` makes, or null when it can.
 *
 * A new file gets mode 0666 with the creator's umask taken out of it, so the
 * umask is what decides whether the user and group actually keep anyone out:
 *
 *   umask 022 -> 0644, so neither the group nor anyone else can write
 *   umask 002 -> 0664, so the group can write
 *   umask 000 -> 0666, so anyone can write
 *
 * Null also covers "cannot tell". A container that states no group could be in
 * the same one, and guessing would invent a problem.
 */
export function blockedBy(creator: MountWriter, other: MountWriter): BlockReason | null {
  // Same user, so the owner bits apply and they are always writable.
  if (creator.user.uid === other.user.uid) return null;

  const mine = creator.user.gid;
  const theirs = other.user.gid;
  if (mine === null || theirs === null) return null;

  if (mine === theirs) return (creator.umask & 0o020) !== 0 ? 'group' : null;
  return (creator.umask & 0o002) !== 0 ? 'other' : null;
}

/**
 * One folder two or more containers write, where one cannot use the other's
 * files.
 *
 * Keyed by folder rather than by container on purpose: the same clash read from
 * each container in turn says the same thing twice, mirrored.
 */
export interface FolderConflict {
  /** The folder they share, which is the deeper of the overlapping mounts. */
  path: string;
  /** Everyone writing it, the blocked containers included. */
  writers: MountWriter[];
  /** The container whose files the others cannot write. */
  creator: MountWriter;
  reason: BlockReason;
}

/** Every folder clash on the box, worst path first for a stable order. */
export function folderConflicts(writers: MountWriter[]): FolderConflict[] {
  const byPath = new Map<string, FolderConflict>();

  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i];
      const b = writers[j];
      if (a.container === b.container) continue;
      if (!pathsOverlap(a.source, b.source)) continue;

      // Each direction is governed by the umask of whoever creates the file.
      const aBlocks = blockedBy(a, b);
      const reason = aBlocks ?? blockedBy(b, a);
      if (!reason) continue;

      // The deeper mount is the folder they genuinely share: the other reaches
      // it through a parent.
      const path = a.source.length >= b.source.length ? a.source : b.source;
      const existing = byPath.get(path);

      if (existing) {
        for (const w of [a, b]) {
          if (!existing.writers.some((x) => x.container === w.container)) {
            existing.writers.push(w);
          }
        }
        continue;
      }

      byPath.set(path, { path, writers: [a, b], creator: aBlocks ? a : b, reason });
    }
  }

  return [...byPath.values()].sort((x, y) => x.path.localeCompare(y.path));
}

/** The identity line shown beside a container in the folder list. */
export function describeWriter(writer: MountWriter): string {
  const umask = `umask ${describeUmask(writer.umask)}`;
  return `${describeUser(writer.user)}, ${writer.umaskStated ? umask : `${umask} assumed`}`;
}

/**
 * One sentence saying who cannot change what, and nothing about how to settle
 * it. Which identity a folder should belong to depends on every other folder
 * those containers touch, which the plugin cannot see, so naming a PUID, a
 * PGID, or a umask here would send a share of users the wrong way. The finding
 * reports the effect and leaves the choice with the user.
 */
export function conflictReason(conflict: FolderConflict): string {
  const { creator, reason } = conflict;
  const others = conflict.writers.filter((w) => w.container !== creator.container);
  const names = others.map((w) => w.container).join(', ');

  if (reason === 'group') {
    return (
      `${creator.container} and ${names} share group ${creator.user.gid}, but ${creator.container} ` +
      `creates files with umask ${describeUmask(creator.umask)}, which leaves them read-only to the ` +
      'rest of that group.'
    );
  }

  return (
    `${creator.container} writes as ${describeUser(creator.user)} and ${names} under a different ` +
    `group, so files ${creator.container} creates are not writable by the others.`
  );
}

function sharedMountFindings(container: Container, conflicts: FolderConflict[]): FindingRule[] {
  const mine = conflicts.filter((c) => c.writers.some((w) => w.container === container.name));
  if (mine.length === 0) return [];

  const shown = mine.slice(0, MAX_SHARED_PATHS);

  // Note-only rows. The other findings name a setting and its replacement, but
  // this one has no replacement to name, and the modal's empty-right-cell
  // wording ("removal") would read as advice to drop the mount.
  const detail: FindingDetail[] = shown.map((conflict) => {
    const own = conflict.writers.find((w) => w.container === container.name)!;
    return {
      note: `${conflict.path}, written as ${describeWriter(own)}. ${conflictReason(conflict)}`,
    };
  });

  const rest = mine.length - shown.length;
  if (rest > 0) {
    detail.push({ note: `And ${rest} more shared folder${rest === 1 ? '' : 's'}.` });
  }

  const onlyUmask = mine.every((c) => c.reason === 'group');

  return [
    {
      type: 'shared-mount-group',
      severity: 'warning',
      title: onlyUmask
        ? 'Writes a shared folder the other containers cannot change'
        : 'Shares a folder with a container in a different group',
      why: onlyUmask
        ? 'Another container writes the same folder. The files created there are read-only to the rest of the group, so the other container cannot move or change them.'
        : 'Two containers write the same folder under different groups. Unraid shares are group-owned, so a file one container creates is one the other cannot change.',
      fix: 'One of these containers can fail to read or change what the other wrote in this folder. Which identity the folder should belong to depends on everything else these containers write, so the plugin does not pick one for you.',
      detail,
    },
  ];
}

/**
 * Every finding for one container, worst first. Dismissals are applied by the
 * caller, not here, so this stays a pure function of the container.
 */
export function findingsFor(
  container: Container,
  bound: PortOwners,
  writers: MountWriter[] = [],
): SecurityFinding[] {
  const findings: FindingRule[] = [];

  if (container.privileged) {
    findings.push({
      type: 'privileged',
      severity: 'critical',
      title: 'Runs in privileged mode',
      why: 'A privileged container gets every Linux capability and access to the host devices, so a compromise inside it is a compromise of the server.',
      fix: `Edit ${container.name} in Unraid and open Show more settings. Add a capability back only if the application documents needing one.`,
      detail: [
        {
          remove: 'Privileged: on',
          add: 'Privileged: off',
        },
        {
          add: '--cap-add=<capability>',
          // Not --cap-drop=ALL alongside it. Turning privileged off already
          // returns the container to Docker's fourteen defaults, and those
          // defaults are what an image needs to drop from root to PUID at
          // startup.
          addNote:
            'Only if the application documents one. Put it in Extra Parameters. Most containers need nothing here.',
        },
      ],
    });
  }

  const socket = (container.mounts ?? []).find(
    (m) => m.Type === 'bind' && m.Source === DOCKER_SOCKET,
  );
  if (socket) findings.push(socketMountFinding(socket));

  if ((container.capAdd ?? []).length > 0) {
    findings.push(capabilityFinding(container, container.capAdd));
  }

  if (isForcedRoot(container.user)) {
    findings.push({
      type: 'forced-root',
      severity: 'warning',
      title: 'Forced to run as root',
      why: 'The template pins the container to uid 0, so the application keeps full root inside the container even if the image was built to drop to PUID and PGID.',
      fix: `Edit ${container.name} in Unraid, open Show more settings, and clear the flag from Extra Parameters.`,
      detail: [
        {
          remove: `--user=${container.user}`,
          removeNote:
            'Most images pick the right user themselves, and linuxserver.io images take PUID and PGID instead, so there is usually nothing to put back.',
        },
      ],
    });
  }

  if (container.networkMode === 'host') {
    // Built last of the critical set on purpose: the suggestion reads better
    // after the reader knows what else is wrong.
    findings.push(hostNetworkFinding(container, bound));
  }

  findings.push(...broadMountFindings(container));
  findings.push(...sharedMountFindings(container, folderConflicts(writers)));

  return findings
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map((f) => ({ ...f, docs: DOCS[f.type] }));
}

export function severityRank(severity: Severity): number {
  return severity === 'critical' ? 0 : 1;
}
