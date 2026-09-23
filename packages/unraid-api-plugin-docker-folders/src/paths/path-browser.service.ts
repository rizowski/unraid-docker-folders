import { Inject, Injectable } from '@nestjs/common';
import { readdirSync, realpathSync, statSync } from 'node:fs';

import { DEFAULT_BACKUP_ALLOWED_ROOTS, isSqliteFile, mapContainerPath } from '../backups/backup.service.js';
import { DOCKER_CLIENT_TOKEN } from '../containers/docker-client.js';
import { normalizePath, pathIsWithin, pathIsWithinAny, safePathComponent } from './paths.js';

/**
 * Path suggestions for the backup forms, ported from `api/paths.php`.
 *
 * Two scopes. `host` completes a destination on the server, confined to the
 * backup roots. `container` completes a path as the container sees it, which
 * is what a user thinks in, and maps it through the container's own mounts to
 * list the host directory underneath.
 *
 * This walks the filesystem with a user-typed path, so the containment rules
 * are the whole point. A host listing never leaves the backup roots, and a
 * container listing never leaves the mount it maps through: every entry is
 * resolved with realpath and rechecked, so a symlink in a share cannot turn
 * the browser into a listing of `/etc`.
 */

export const PATH_SUGGEST_LIMIT = 50;
export const PATH_SQLITE_SCAN_LIMIT = 200;

/** Network mounts. Statting their entries can hang on a slow server. */
const REMOTE_ROOT = '/mnt/remotes';

export interface PathSuggestion {
    name: string;
    path: string;
}

export interface PathSuggestions {
    base: string;
    entries: PathSuggestion[];
    has_sqlite: boolean;
}

interface BrowserMount {
    Type?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
}

/** The slice of the Docker client this reads. */
export interface BrowserDockerClient {
    listContainers(options: { all: boolean }): Promise<{ Id: string; Names?: string[]; Labels?: Record<string, string> | null }[]>;
    getContainer(id: string): { inspect(): Promise<{ Mounts?: BrowserMount[] }> };
}

const EMPTY: PathSuggestions = { base: '', entries: [], has_sqlite: false };

@Injectable()
export class PathBrowserService {
    constructor(@Inject(DOCKER_CLIENT_TOKEN) private readonly docker: BrowserDockerClient) {}

    suggestHostPaths(typedRaw: string, roots: readonly string[] = DEFAULT_BACKUP_ALLOWED_ROOTS): PathSuggestions {
        const typed = typedRaw.trim();

        // Until the user has typed past a root, offer the roots themselves.
        const matchingRoots = roots
            .filter((root) => typed === '' || startsWithIgnoreCase(root, typed))
            .map((root) => ({ name: root, path: root }));
        if (matchingRoots.length > 0) return { base: '', entries: matchingRoots, has_sqlite: false };

        const [parentRaw, prefix] = splitTypedPath(typed);
        const parent = normalizePath(parentRaw);
        if (parent === null || !pathIsWithinAny(parent, roots)) return EMPTY;

        const entries = listDirectoryNames(parent, prefix).map((name) => ({
            name,
            path: `${parent.replace(/\/+$/, '')}/${name}`,
        }));
        return { base: parent, entries, has_sqlite: false };
    }

    async suggestContainerPaths(containerName: string, typedRaw: string, project = ''): Promise<PathSuggestions> {
        const typed = typedRaw.trim();
        if (containerName === '') return EMPTY;

        const mounts = await this.containerMounts(containerName, project);
        if (mounts.length === 0) return EMPTY;

        const [parent, prefix] = splitTypedPath(typed);
        const mapped = parent === '' ? null : mapContainerPath(parent, mounts);

        // Not inside any mount yet: offer the mount points themselves.
        if (mapped === null) {
            const entries: PathSuggestion[] = [];
            for (const mount of mounts) {
                const dest = (mount.Destination ?? '').replace(/\/+$/, '');
                if (dest === '' || (typed !== '' && !startsWithIgnoreCase(dest, typed))) continue;
                entries.push({ name: dest, path: dest });
            }
            return { base: '', entries, has_sqlite: false };
        }

        const hostParent = mapped.hostPath;
        if (!pathIsWithin(hostParent, mapped.mountSource)) return EMPTY;

        const entries = listDirectoryNames(hostParent, prefix, mapped.mountSource).map((name) => ({
            name,
            path: `${parent.replace(/\/+$/, '')}/${name}`,
        }));
        return { base: parent, entries, has_sqlite: directoryHasSqlite(hostParent) };
    }

    /**
     * A container's mounts, by name, or by Compose service name within a
     * project. The name is checked before it reaches Docker, as in PHP.
     */
    private async containerMounts(containerName: string, project: string): Promise<BrowserMount[]> {
        try {
            if (project === '') {
                if (safePathComponent(containerName) === null) return [];
                return (await this.docker.getContainer(containerName).inspect()).Mounts ?? [];
            }

            for (const container of await this.docker.listContainers({ all: true })) {
                const labels = container.Labels ?? {};
                const name = (container.Names?.[0] ?? '').replace(/^\//, '');
                const inProject = labels['com.docker.compose.project'] === project;
                const matches =
                    name === containerName || (labels['com.docker.compose.service'] === containerName && inProject);
                if (!matches) continue;
                return (await this.docker.getContainer(container.Id).inspect()).Mounts ?? [];
            }
        } catch {
            return [];
        }
        return [];
    }
}

/**
 * Split what was typed into the directory to list and the name prefix to
 * filter by. `/mnt/us` lists `/mnt` for names starting "us"; `/mnt/user/`
 * lists `/mnt/user` for everything.
 */
export function splitTypedPath(typed: string): [string, string] {
    if (typed === '' || typed.endsWith('/')) {
        const trimmed = typed.replace(/\/+$/, '');
        return [trimmed === '' ? typed : trimmed, ''];
    }
    const slash = typed.lastIndexOf('/');
    if (slash === -1) return ['', typed];
    return [slash === 0 ? '/' : typed.slice(0, slash), typed.slice(slash + 1)];
}

/**
 * Subdirectories of `parent` whose names start with `prefix`, at most
 * PATH_SUGGEST_LIMIT of them, sorted.
 *
 * Sorted before the limit is applied, because PHP's `scandir` returns names
 * sorted and the PHP takes the first fifty of those. Node's directory order is
 * whatever the filesystem gives, so without this the two backends would offer
 * different fifty on a large share.
 *
 * With `containBase`, each entry is resolved with realpath and dropped unless
 * it stays inside that base, so a symlink cannot lead out of the mount.
 */
function listDirectoryNames(parent: string, prefix: string, containBase: string | null = null): string[] {
    let all: string[];
    try {
        if (!statSync(parent).isDirectory()) return [];
        all = readdirSync(parent).sort(byteOrder);
    } catch {
        return [];
    }

    // Entries under a network mount are returned without a stat, which could
    // hang the request on a slow remote.
    const remote = pathIsWithin(parent, REMOTE_ROOT);

    const names: string[] = [];
    for (const name of all) {
        if (name === '.' || name === '..') continue;
        if (prefix !== '' && !startsWithIgnoreCase(name, prefix)) continue;

        if (!remote) {
            const full = `${parent.replace(/\/+$/, '')}/${name}`;
            try {
                if (!statSync(full).isDirectory()) continue;
                if (containBase !== null && !pathIsWithin(realpathSync(full), containBase)) continue;
            } catch {
                continue;
            }
        }

        names.push(name);
        if (names.length >= PATH_SUGGEST_LIMIT) break;
    }

    return names.sort(byteOrder);
}

function directoryHasSqlite(directory: string): boolean {
    try {
        if (!statSync(directory).isDirectory() || pathIsWithin(directory, REMOTE_ROOT)) return false;
    } catch {
        return false;
    }

    let scanned = 0;
    for (const name of readdirSync(directory).sort(byteOrder)) {
        if (name === '.' || name === '..') continue;
        if (scanned++ >= PATH_SQLITE_SCAN_LIMIT) break;
        if (isSqliteFile(`${directory.replace(/\/+$/, '')}/${name}`)) return true;
    }
    return false;
}

/** PHP's `strncasecmp($a, $b, strlen($b)) === 0`: an ASCII case-insensitive prefix. */
function startsWithIgnoreCase(value: string, prefix: string): boolean {
    return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** PHP's `sort()` on strings compares bytes, which is JavaScript's default too. */
function byteOrder(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
