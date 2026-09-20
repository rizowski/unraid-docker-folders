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
 */
export interface FindingDetail {
  /** The current setting, as Unraid or `docker run` spells it. */
  remove?: string;
  /** What to put in its place. */
  add?: string;
  /** One line on why, for this row only. */
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
 * What to do about each broad path. Narrowing the path is the real fix, so it
 * comes first; read-only access is the fallback for a container that genuinely
 * needs to see the wider tree. The paths that cannot be narrowed sensibly say
 * so instead of pretending otherwise.
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
  note: 'Name the one share the application reads and leave the container path alone, or keep the mount and set Access Mode to Read Only.',
};

const BROAD_PATH_ADVICE: Record<string, MountAdvice> = {
  '/': { note: 'No application needs the whole filesystem.' },
  '/boot': {
    note: '/boot is the flash drive holding the server configuration, and a container that writes there can stop the server from booting.',
  },
  '/etc': { note: 'Point it at the one file the application reads, or drop it.' },
  '/var/run': { note: 'Point it at the one socket the application needs, or drop it.' },
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
      note: advice?.note,
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
        note: readOnly
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
        note:
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
      why: 'The container can change anything under that path, which covers files no single application needs.',
      fix: `Edit ${container.name} in Unraid and change the volume mapping. Narrowing Host Path is the real fix; Access Mode Read Only is the fallback when the container has to see the wider tree.`,
      detail: offenders.map((m) => {
        const advice = BROAD_PATH_ADVICE[m.Source];
        return {
          remove: `${m.Source} -> ${m.Destination} (Read/Write)`,
          // Only the new Host Path. The container path is not changing, so
          // repeating it on the right makes the reader diff two strings to
          // find the one field that moved.
          add: advice?.path,
          note: advice?.note,
        };
      }),
    },
  ];
}

/**
 * Every finding for one container, worst first. Dismissals are applied by the
 * caller, not here, so this stays a pure function of the container.
 */
export function findingsFor(container: Container, bound: PortOwners): SecurityFinding[] {
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
          note: 'Only if the application documents one. Put it in Extra Parameters. Most containers need nothing here.',
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
          note: 'Most images pick the right user themselves, and linuxserver.io images take PUID and PGID instead, so there is usually nothing to put back.',
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

  return findings
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map((f) => ({ ...f, docs: DOCS[f.type] }));
}

export function severityRank(severity: Severity): number {
  return severity === 'critical' ? 0 : 1;
}
