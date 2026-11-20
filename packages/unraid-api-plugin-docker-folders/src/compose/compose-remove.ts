import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { normalizePath, pathIsWithin, resolveAgainst } from '../paths/paths.js';
import { nowSeconds } from '../util/time.js';
import { COMPOSE_FILENAMES } from './compose-config.js';

/**
 * Removing a stack from the plugin, ported from `ComposeManager::removeStack`
 * and `ownStackDir`. See the PHP doc comments for the reasoning; this file
 * keeps the same rules so the two backends leave the same state behind.
 */

/** The `com.docker.compose.project` label. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** The slice of a listed container removal reads. */
export interface RemoveContainer {
    name: string;
    labels: Readonly<Record<string, string>>;
}

interface StackRow {
    project_name: string;
    working_dir: string | null;
    compose_file: string | null;
    env_file: string | null;
}

export type RemoveStackResult =
    | { success: false; code: 'not_found' | 'in_use'; error: string }
    | {
          success: true;
          schedulesRemoved: number;
          folder: 'deleted' | 'kept' | 'none';
          filesRemoved: string[];
          directoryRemoved: boolean;
          filesNote: string | null;
      };

export function removeComposeStack(
    db: { write<T>(fn: (handle: DatabaseSync) => T): T; read<T>(fn: (handle: DatabaseSync) => T): T },
    projectName: string,
    deleteFiles: boolean,
    containers: readonly RemoveContainer[],
    stacksDir: string
): RemoveStackResult {
    const rows = db.read(
        (handle) => handle.prepare('SELECT * FROM compose_stacks').all() as unknown as StackRow[]
    );
    const row = rows.find((candidate) => candidate.project_name === projectName);
    if (row === undefined) return { success: false, code: 'not_found', error: 'Stack not found' };

    const others = rows.filter((candidate) => candidate.project_name !== projectName);

    // Every listed container is recorded, labelled or not: a plain one the
    // user dragged into the stack folder is a live container that is not this
    // stack's, and must keep its folder.
    const liveProjects = new Map<string, string | null>();
    let inUse = false;
    for (const container of containers) {
        const label = container.labels[COMPOSE_PROJECT_LABEL];
        liveProjects.set(container.name.replace(/^\//, ''), label ?? null);
        if (label === projectName) inUse = true;
    }
    if (inUse) {
        return {
            success: false,
            code: 'in_use',
            error: `Containers of "${projectName}" still exist. Run Stack Down first, or the stack comes back on the next refresh.`,
        };
    }

    let ownDir: string | null = null;
    let filesNote: string | null = null;
    if (deleteFiles) {
        [ownDir, filesNote] = ownStackDir(row.working_dir, stacksDir, others);
        // A container created from this directory still reads its files.
        if (ownDir !== null && containersRunFrom(containers, ownDir)) {
            ownDir = null;
            filesNote = 'Containers still run from this directory, so the files were left in place.';
        }
    }

    const counts = db.write((handle) => {
        const schedules = handle
            .prepare("DELETE FROM schedules WHERE target_type = 'stack' AND target_id = ?")
            .run(projectName);

        let folder: 'deleted' | 'kept' | 'none' = 'none';
        const folders = handle.prepare('SELECT id FROM folders WHERE compose_project = ?').all(projectName) as {
            id: number;
        }[];
        for (const { id } of folders) {
            const members = handle.prepare('SELECT container_name FROM container_folders WHERE folder_id = ?').all(id) as {
                container_name: string;
            }[];
            const foreign = members.some((member) => {
                return liveProjects.has(member.container_name) && liveProjects.get(member.container_name) !== projectName;
            });
            if (foreign) {
                handle
                    .prepare('UPDATE folders SET compose_project = NULL, updated_at = ? WHERE id = ?')
                    .run(nowSeconds(), id);
                folder = 'kept';
            } else {
                handle.prepare('DELETE FROM folders WHERE id = ?').run(id);
                if (folder !== 'kept') folder = 'deleted';
            }
        }

        // Version history goes by cascade. Foreign keys are on (database.service.ts).
        handle.prepare('DELETE FROM compose_stacks WHERE project_name = ?').run(projectName);
        return { schedules: Number(schedules.changes), folder };
    });

    let filesRemoved: string[] = [];
    let directoryRemoved = false;
    if (deleteFiles && ownDir !== null) {
        const removed = deleteStackFiles(ownDir, row);
        filesRemoved = removed.files;
        directoryRemoved = removed.directoryRemoved;
        if (!directoryRemoved) {
            filesNote = 'The directory still holds files the plugin did not create, so it was left in place.';
        }
    }

    return {
        success: true,
        schedulesRemoved: counts.schedules,
        folder: counts.folder,
        filesRemoved,
        directoryRemoved,
        filesNote,
    };
}

const WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';

/**
 * Was any listed container created from `dir`? True when its working_dir label,
 * or any path in its config_files label, is `dir` or inside it. A relative
 * config file is joined to the working_dir first.
 */
export function containersRunFrom(containers: readonly RemoveContainer[], dir: string): boolean {
    for (const container of containers) {
        const workingDir = container.labels[WORKING_DIR_LABEL] ?? null;
        if (workingDir !== null && pathIsWithin(workingDir, dir)) return true;
        for (const file of (container.labels[CONFIG_FILES_LABEL] ?? '').split(',')) {
            const path = file.trim() === '' ? null : resolveAgainst(file.trim(), workingDir);
            if (path !== null && pathIsWithin(path, dir)) return true;
        }
    }
    return false;
}

/** The names a stack's compose file may have, and the names an env file may have. */
function isComposeFileName(name: string): boolean {
    return (COMPOSE_FILENAMES as readonly string[]).includes(name);
}

function isEnvFileName(name: string): boolean {
    return name === '.env' || /^[A-Za-z0-9._-]+\.env$/.test(name);
}

/**
 * Is a stack's working_dir a direct child of the plugin's own stack folder? A
 * path check only. The UI uses it to offer "delete the files", and
 * `ownStackDir` checks the disk again before anything is deleted.
 */
export function isOwnStackPath(workingDir: string | null, stacksDir: string): boolean {
    const dir = workingDir ? normalizePath(workingDir) : null;
    const base = normalizePath(stacksDir);
    return dir !== null && base !== null && base !== '/' && pathIsWithin(dir, base) && dirname(dir) === base;
}

/**
 * The directory a stack's own copy lives in, when it is safe to delete from.
 *
 * A direct child of `stacksDir` (so not `stacksDir` itself, and not `..`,
 * which `normalizePath` collapses before the test), not a symlink, and still
 * inside `stacksDir` once `realpath` has resolved it. No other stack may keep
 * a path inside it. Anything else is not the plugin's to delete: a
 * compose.manager project, a user's appdata.
 */
export function ownStackDir(
    workingDir: string | null,
    stacksDir: string,
    otherRows: readonly StackRow[]
): [string | null, string | null] {
    if (workingDir === null || workingDir === '') {
        return [null, 'The stack has no working directory, so no files were deleted.'];
    }

    const dir = normalizePath(workingDir);
    const base = normalizePath(stacksDir);
    const notOwn = "The files are not in the plugin's own stack directory, so they were left in place.";

    if (dir === null || base === null || !isOwnStackPath(workingDir, stacksDir)) return [null, notOwn];

    let stat;
    try {
        stat = lstatSync(dir);
    } catch {
        return [null, null]; // nothing on disk
    }
    if (stat.isSymbolicLink()) return [null, notOwn];
    if (!stat.isDirectory()) return [null, notOwn];

    let realDir: string;
    let realBase: string;
    try {
        realDir = realpathSync(dir);
        realBase = realpathSync(base);
    } catch {
        return [null, notOwn];
    }
    if (!pathIsWithin(realDir, realBase) || dirname(realDir) !== realBase) return [null, notOwn];

    for (const other of otherRows) {
        for (const value of [other.working_dir, other.compose_file, other.env_file]) {
            const path = typeof value === 'string' ? normalizePath(value) : null;
            if (path !== null && (path === dir || pathIsWithin(path, dir))) {
                return [null, 'Another stack uses files in this directory, so they were left in place.'];
            }
        }
    }

    return [dir, null];
}

/**
 * Delete the files the plugin keeps for a stack inside its own directory, then
 * the directory if that leaves it empty. Never recursive: a file the plugin did
 * not write stops the directory from going.
 */
function deleteStackFiles(dir: string, row: StackRow): { files: string[]; directoryRemoved: boolean } {
    const removed: string[] = [];

    // Version snapshots: .versions/<timestamp>-<compose.yml|env.env>.
    const versions = `${dir}/.versions`;
    try {
        if (lstatSync(versions).isDirectory()) {
            for (const entry of readdirSync(versions)) {
                if (/^\d+-(compose\.yml|env\.env)$/.test(entry) && tryUnlink(`${versions}/${entry}`)) {
                    removed.push(`.versions/${entry}`);
                }
            }
            tryRmdir(versions);
        }
    } catch {
        // No .versions directory.
    }

    // Only names the plugin writes. The row's paths come from container labels
    // too, so a name outside the allowlist is left on disk, and the directory
    // with it.
    const names = new Set<string>([...COMPOSE_FILENAMES, '.env']);
    for (const [value, allowed] of [
        [row.compose_file, isComposeFileName],
        [row.env_file, isEnvFileName],
    ] as const) {
        const path = typeof value === 'string' ? normalizePath(value) : null;
        if (path !== null && dirname(path) === dir && allowed(basename(path))) names.add(basename(path));
    }
    for (const name of names) {
        const file = `${dir}/${name}`;
        let isFileOrLink = false;
        try {
            const stat = lstatSync(file);
            isFileOrLink = stat.isFile() || stat.isSymbolicLink();
        } catch {
            // Absent.
        }
        if (isFileOrLink && tryUnlink(file)) removed.push(name);
    }

    return { files: removed, directoryRemoved: tryRmdir(dir) };
}

function tryUnlink(path: string): boolean {
    try {
        unlinkSync(path);
        return true;
    } catch {
        return false;
    }
}

function tryRmdir(path: string): boolean {
    try {
        rmdirSync(path);
        return true;
    } catch {
        return false;
    }
}
