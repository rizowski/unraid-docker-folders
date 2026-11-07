import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Tell Unraid's own Docker manager that a recreate made an image current
 * (issue #23). The port of PHP's `include/unraidUpdateStatus.php`; that file's
 * header explains the two files and why each write looks the way it does.
 */

export interface UnraidStatusPaths {
    /** Per-tag status, keyed by `unraidImageKey()`. */
    status: string;
    /** The Docker tab's container cache, keyed by container name. */
    webui: string;
}

export const UNRAID_STATUS_PATHS: UnraidStatusPaths = {
    status: '/var/lib/docker/unraid-update-status.json',
    webui: '/usr/local/emhttp/state/plugins/dynamix.docker.manager/docker.json',
};

interface StatusEntry {
    local: string | null;
    remote: string | null;
    status: string;
}

type JsonObject = Record<string, unknown>;

const SPLIT_IMAGE = /^(.+\/)*([^/:]+)(:[^:/]*)*$/;
const BARE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PULL_DIGEST_LINE = /^Digest:\s*(sha256:[0-9a-f]{64})\s*$/;

/**
 * Unraid's `DockerUtil::ensureImageTag()`: `library/` for a name with no
 * slash, `:latest` for one with no tag. Tested against
 * `__tests__/unraid-image-keys.fixture.json`, which
 * `scripts/unraid-key-oracle.php` builds from Unraid's own code.
 *
 * Null for an ID or a digest reference, which Unraid's parser turns into a
 * meaningless key.
 */
export function unraidImageKey(image: string): string | null {
    let ref = image.trim();
    if (ref === '' || ref.startsWith('sha256:') || ref.includes('@')) return null;
    if (!ref.includes('/')) ref = `library/${ref}`;

    let repo = ref;
    let tag = '';
    const m = SPLIT_IMAGE.exec(ref);
    if (m) {
        repo = (m[1] ?? '') + m[2];
        tag = (m[3] ?? '').replaceAll(':', '');
    }
    if (tag === '') tag = 'latest';
    return `${repo.trim()}:${tag.trim()}`;
}

/** A bare `sha256:<hex>`, from that form or `repo@sha256:<hex>`. */
export function bareImageDigest(digest: unknown): string | null {
    if (typeof digest !== 'string' || digest === '') return null;
    const at = digest.lastIndexOf('@');
    const bare = at === -1 ? digest : digest.slice(at + 1);
    return BARE_DIGEST.test(bare) ? bare : null;
}

/** The digest in a pull stream's `Digest: sha256:...` status line. */
export function pullDigestFromStatus(status: unknown): string | null {
    if (typeof status !== 'string') return null;
    return PULL_DIGEST_LINE.exec(status)?.[1] ?? null;
}

/**
 * `{}` for a missing file, null for one that exists but does not decode to an
 * object, including an empty file caught in the middle of Unraid's write.
 */
export function readUnraidJson(path: string): JsonObject | null {
    if (!existsSync(path)) return {};
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return null;
    }
    if (raw.trim() === '') return null;
    try {
        const data: unknown = JSON.parse(raw);
        // Unraid's saveJSON() writes an empty PHP array as `[]`. Any other
        // list is not something to add keys to.
        if (Array.isArray(data)) return data.length === 0 ? {} : null;
        return data !== null && typeof data === 'object' ? (data as JsonObject) : null;
    } catch {
        return null;
    }
}

/**
 * Replace the file atomically, in the format Unraid's `saveJSON()` writes
 * (`JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES`, four-space indent). The temp
 * file sits beside it: `/var/lib/docker` is often a loop mount.
 */
export function writeUnraidJson(path: string, data: JsonObject): boolean {
    const dir = dirname(path);
    if (!existsSync(dir)) return false;
    let mode = 0o644;
    try {
        mode = statSync(path).mode & 0o777;
    } catch {
        // New file.
    }
    const tmp = join(dir, `.${basename(path)}.dfm-${process.pid}.tmp`);
    try {
        writeFileSync(tmp, JSON.stringify(data, null, 4));
        chmodSync(tmp, mode);
        renameSync(tmp, path);
        return true;
    } catch {
        try {
            unlinkSync(tmp);
        } catch {
            // Already gone.
        }
        return false;
    }
}

/** Drop containers from the Docker tab's cache, so it recomputes their status. */
export function dropUnraidWebuiEntries(names: string[], webuiPath: string): boolean {
    if (names.length === 0 || !existsSync(webuiPath)) return false;
    const info = readUnraidJson(webuiPath);
    if (info === null) return false;
    let changed = false;
    for (const name of names) {
        if (Object.hasOwn(info, name)) {
            delete info[name];
            changed = true;
        }
    }
    return changed && writeUnraidJson(webuiPath, info);
}

/**
 * `DockerUpdate::setUpdateStatus()` for one pulled image, plus the cache drop.
 * Writes nothing without a digest: the Unraid API reads a status of "true"
 * with no digests as an update.
 */
export function markUnraidImageCurrent(
    image: string,
    digest: string | null,
    containerNames: string[],
    paths: UnraidStatusPaths = UNRAID_STATUS_PATHS
): boolean {
    const key = unraidImageKey(image);
    const bare = bareImageDigest(digest);
    if (key === null || bare === null) return false;

    const status = readUnraidJson(paths.status);
    if (status === null) return false;
    const entry: StatusEntry = { local: bare, remote: bare, status: 'true' };
    status[key] = entry;
    if (!writeUnraidJson(paths.status, status)) return false;

    dropUnraidWebuiEntries(containerNames, paths.webui);
    return true;
}

/** Containers whose resolved image has Unraid key `image`'s key. */
export function containerNamesForImage(containers: StatusContainer[], image: string): string[] {
    const key = unraidImageKey(image);
    if (key === null) return [];
    return containers.filter((c) => c.name !== '' && unraidImageKey(c.image) === key).map((c) => c.name);
}

export interface StatusContainer {
    name: string;
    /** The resolved image reference, not Docker's raw one. */
    image: string;
    /** Missing counts as behind, so the tag is never marked current by mistake. */
    imageId?: string;
}

/** Containers created from `image`'s tag that run some other image. */
export function containersBehindImage(containers: StatusContainer[], image: string, imageId: string): string[] {
    const key = unraidImageKey(image);
    if (key === null) return [];
    return containers.filter((c) => unraidImageKey(c.image) === key && (c.imageId ?? '') !== imageId).map((c) => c.name);
}

/**
 * The pull's own `Digest:` line when this request pulled. Otherwise the
 * first candidate that is one of the image's RepoDigests, so a newer build
 * on the registry is never recorded as the one on disk.
 */
export function pickUnraidDigest(
    pullDigest: string | null,
    repoDigests: string[],
    candidates: (string | null)[]
): string | null {
    const pulled = bareImageDigest(pullDigest);
    if (pulled !== null) return pulled;
    const local = repoDigests.map(bareImageDigest).filter((d): d is string => d !== null);
    for (const candidate of candidates) {
        const bare = bareImageDigest(candidate);
        if (bare !== null && local.includes(bare)) return bare;
    }
    return null;
}

/**
 * Clear flags left by pulls made before this fix. Touches only an entry with
 * status "false" whose `remote` digest is one of the image's RepoDigests, and
 * only when every container on that tag runs that image.
 *
 * @param inspect The tag's image id and RepoDigests, or null when it is not on disk
 * @returns Keys that were repaired
 */
export async function repairUnraidUpdateStatus(
    inspect: (key: string) => Promise<{ id: string; repoDigests: string[] } | null>,
    containers: StatusContainer[],
    paths: UnraidStatusPaths = UNRAID_STATUS_PATHS
): Promise<string[]> {
    const status = readUnraidJson(paths.status);
    if (status === null) return [];

    const repaired: string[] = [];
    for (const [key, value] of Object.entries(status)) {
        if (value === null || typeof value !== 'object') continue;
        const entry = value as Partial<StatusEntry>;
        if (entry.status !== 'false') continue;
        const remote = bareImageDigest(entry.remote);
        if (remote === null || entry.local === remote) continue;
        const image = await inspect(key);
        if (image === null) continue;
        if (
            image.repoDigests.map(bareImageDigest).includes(remote) &&
            containersBehindImage(containers, key, image.id).length === 0
        ) {
            status[key] = { local: remote, remote, status: 'true' } satisfies StatusEntry;
            repaired.push(key);
        }
    }

    if (repaired.length === 0 || !writeUnraidJson(paths.status, status)) return [];

    const names = new Set<string>();
    for (const key of repaired) {
        for (const name of containerNamesForImage(containers, key)) names.add(name);
    }
    dropUnraidWebuiEntries([...names], paths.webui);
    return repaired;
}
