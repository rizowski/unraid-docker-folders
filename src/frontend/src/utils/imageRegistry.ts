/**
 * Turn a container's image reference into a page a person can actually open.
 *
 * Docker's reference format is not a URL and no registry publishes a mapping,
 * so each host needs its own rule. Two of them are not their own website at
 * all: lscr.io serves images and nothing else, and ghcr.io answers the registry
 * API but has no browsable page, so both point somewhere that does.
 *
 * Every URL shape here was opened in a browser. Do not add one that was not.
 */

export interface ImageRef {
  /** Registry host, or null when the reference carries none (Docker Hub). */
  host: string | null;
  /** Everything between the host and the tag, e.g. "linuxserver/plex". */
  path: string;
  /** The tag, or null for a digest reference or a bare name. */
  tag: string | null;
}

/**
 * Split "lscr.io/linuxserver/plex:latest" into its parts.
 *
 * The first segment is a host only when it looks like one, which is how Docker
 * itself decides: a dot, a colon, or the exact word "localhost". Without that
 * test, "linuxserver/plex" would read as host "linuxserver".
 */
export function parseImageRef(image: string): ImageRef | null {
  const ref = String(image ?? '').trim();
  if (!ref) return null;

  // A digest pins the image and replaces the tag. Drop it: no registry offers a
  // useful page for a bare digest, so the repository page is the best answer.
  const [withoutDigest] = ref.split('@');
  if (!withoutDigest) return null;

  const segments = withoutDigest.split('/');
  const looksLikeHost =
    segments.length > 1 &&
    (segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost');

  const host = looksLikeHost ? segments[0] : null;
  const rest = looksLikeHost ? segments.slice(1).join('/') : withoutDigest;

  // Only a colon after the last slash is a tag. A colon before one is the
  // registry's port, as in "myreg:5000/app".
  const colon = rest.lastIndexOf(':');
  const hasTag = colon > rest.lastIndexOf('/');

  const path = hasTag ? rest.slice(0, colon) : rest;
  const tag = hasTag ? rest.slice(colon + 1) : null;

  if (!path) return null;
  return { host, path, tag: tag || null };
}

/** Docker Hub, where a one-segment path means an official image. */
function dockerHubUrl(path: string, tag: string | null): string {
  const base = path.includes('/')
    ? `https://hub.docker.com/r/${path}`
    : `https://hub.docker.com/_/${path}`;
  return tag ? `${base}/tags?name=${encodeURIComponent(tag)}` : base;
}

/**
 * A page for the image, or null when the reference cannot be read.
 *
 * The tag is only carried where the registry has a stable URL for one. The
 * others land on the repository page, which is still the page that documents
 * the ports and variables the advisor tells people to go and check.
 */
export function imageRegistryUrl(image: string): string | null {
  const ref = parseImageRef(image);
  if (!ref) return null;

  const { host, path, tag } = ref;

  if (host === null || host === 'docker.io' || host === 'index.docker.io') {
    return dockerHubUrl(path, tag);
  }

  // lscr.io is a pull-through for linuxserver.io images and serves no page of
  // its own. The same repository lives on Docker Hub under the same name.
  if (host === 'lscr.io') {
    return dockerHubUrl(path, tag);
  }

  // GHCR answers the registry API but has no web page. GitHub's package page
  // does, and it needs only the owner and the package name. An image owned by a
  // personal account lives under /users/ instead, which the reference cannot
  // tell apart, so that one lands on a GitHub 404.
  if (host === 'ghcr.io') {
    const [owner, ...pkg] = path.split('/');
    if (!owner || pkg.length === 0) return null;
    return `https://github.com/orgs/${owner}/packages/container/package/${pkg.join('%2F')}`;
  }

  if (host === 'quay.io') {
    return `https://quay.io/repository/${path}`;
  }

  if (host === 'registry.gitlab.com') {
    return `https://gitlab.com/${path}/container_registry`;
  }

  // An unknown registry. Its host is the only thing we can offer, which is what
  // the container card did for every non-Docker-Hub image before this existed.
  return `https://${host}/${path}`;
}
