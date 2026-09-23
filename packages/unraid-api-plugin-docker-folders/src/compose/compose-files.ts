/**
 * Compose/env file read, write, and version history — ported from the "File
 * I/O" and "File Versioning" sections of `ComposeManager.php` (lines
 * 966-1333).
 *
 * Plain functions taking a `DatabaseSync` handle, not a class, the same
 * pattern `folder.service.ts` uses for `reconcileIds`/`syncComposeProjects`:
 * `ComposeService` opens one `DatabaseService.read()`/`write()` handle per
 * call and passes it through, rather than each of these opening its own.
 *
 * PATH VALIDATION: deliberately absent here, matching PHP. `compose_file`
 * and `env_file` are label-derived (via `FolderService`'s ported
 * `upsertComposeStack`) or set by `createStack` to a path this module itself
 * picked, and the one column a request can set directly — `env_file`, through
 * `set_env_path` — is validated once, at the HTTP boundary
 * (`ComposeResolver.setDockerFoldersComposeEnvPath`), exactly where
 * `api/compose.php`'s `set_env_path` branch does it and for the same reason
 * given there: `upsertStack`/these readers are reachable from the
 * container-list path with a `working_dir` that legitimately points anywhere
 * on the box, so containment here would break the container list for
 * genuine stacks. See CLAUDE.md, "Validation lives at the HTTP boundary."
 *
 * The one exception is version-history bookkeeping (`snapshotVersion`,
 * `pruneVersions`, `getFileVersionContent`), which DOES check containment —
 * ported unchanged, including the comment explaining why: those files are
 * plugin-written under `working_dir`, but `working_dir` itself can be empty
 * or `/` (a label can claim anything), and `getFileVersionContent` is
 * reachable from a plain GET.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

import type { Row } from '../db/database.service.js';
import { normalizePath, pathIsWithin, resolveAgainst } from '../paths/paths.js';
import { nowSeconds } from '../util/time.js';
import { COMPOSE_FILENAMES } from './compose-config.js';

export interface StackFileFields {
    working_dir: string | null;
    compose_file: string | null;
    env_file?: string | null;
}

export interface FileResult {
    success: boolean;
    error: string | null;
    content: string | null;
    path: string | null;
}

export interface FileVersionRow {
    id: number;
    file_type: 'compose' | 'env';
    file_path: string;
    content_hash: string;
    created_at: number;
}

export interface FileVersionDetail extends FileVersionRow {
    content: string;
}

/** `ComposeManager::findComposeFile`. First matching filename in `dir`, or null. */
export function findComposeFile(dir: string): string | null {
    const base = dir.replace(/\/+$/, '');
    for (const name of COMPOSE_FILENAMES) {
        const candidate = `${base}/${name}`;
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * `ComposeManager::resolveComposeFilePath`. An explicit `compose_file` wins;
 * a relative one is joined onto `working_dir`. Otherwise the first
 * recognised filename found in `working_dir`, or `docker-compose.yml` there
 * even if it does not exist yet (a path for a caller that is about to create
 * it) — never `null` while `working_dir` is set.
 */
export function resolveComposeFilePath(stack: StackFileFields): string | null {
    if (stack.compose_file) {
        const path = stack.compose_file;
        if (path[0] !== '/' && stack.working_dir) {
            return `${stack.working_dir.replace(/\/+$/, '')}/${path}`;
        }
        return path;
    }

    if (stack.working_dir) {
        const found = findComposeFile(stack.working_dir);
        if (found !== null) return found;
        return `${stack.working_dir.replace(/\/+$/, '')}/docker-compose.yml`;
    }

    return null;
}

/** `ComposeManager::resolveEnvFilePath`. Defaults to `.env` in `working_dir`. */
export function resolveEnvFilePath(stack: StackFileFields): string | null {
    if (stack.env_file) {
        const path = stack.env_file;
        if (path[0] !== '/' && stack.working_dir) {
            return `${stack.working_dir.replace(/\/+$/, '')}/${path}`;
        }
        return path;
    }

    if (stack.working_dir) {
        return `${stack.working_dir.replace(/\/+$/, '')}/.env`;
    }

    return null;
}

/**
 * `ComposeManager::parseComposeServiceNames`. Lightweight line-based YAML
 * scan for the top-level keys under `services:`, so listing stacks does not
 * need to shell out to `docker compose config` for every one.
 *
 * Ported bug: the comment-stripping regex below removes everything from an
 * unquoted `#` onward, including one that appears inside a quoted scalar
 * value (e.g. `image: "redis#1"` loses `#1"`). ComposeManager.php:269 has the
 * exact same regex and the exact same gap. Harmless for a service *name*
 * line, which never contains a `#`, but reported as-is per instructions.
 */
export function parseComposeServiceNames(content: string): string[] {
    if (!content) return [];

    const services: string[] = [];
    const lines = content.split(/\r?\n/);
    let inServices = false;
    let baseIndent: number | null = null;

    for (const rawLine of lines) {
        const stripped = rawLine.replace(/^([^#]*?)\s*#.*$/, '$1');
        const line = stripped ?? rawLine;

        if (!inServices) {
            if (/^services\s*:\s*$/.test(line)) inServices = true;
            continue;
        }

        if (line.trim() === '') continue;

        // A non-indented key ends the services block.
        if (/^\S/.test(line)) break;

        const match = line.match(/^(\s+)([a-zA-Z0-9._-]+)\s*:\s*$/);
        if (match) {
            const indent = match[1].length;
            if (baseIndent === null) baseIndent = indent;
            if (indent === baseIndent) services.push(match[2]);
        }
    }

    return services;
}

function readStack(db: DatabaseSync, projectName: string): (Row & StackFileFields) | undefined {
    return db
        .prepare('SELECT * FROM compose_stacks WHERE project_name = ?')
        .get(projectName) as (Row & StackFileFields) | undefined;
}

/** `ComposeManager::getComposeFileContent`. Read-only; call within `DatabaseService.read()`. */
export function getComposeFileContent(db: DatabaseSync, projectName: string): FileResult {
    const stack = readStack(db, projectName);
    if (!stack) return { success: false, error: 'Stack not found', content: null, path: null };

    const path = resolveComposeFilePath(stack);
    if (!path || !existsSync(path)) {
        return {
            success: false,
            error: `Compose file not found at: ${path ?? 'unknown'}`,
            content: null,
            path,
        };
    }

    try {
        return { success: true, error: null, content: readFileSync(path, 'utf8'), path };
    } catch {
        return { success: false, error: 'Failed to read compose file', content: null, path };
    }
}

/** `ComposeManager::getEnvFileContent`. A missing env file is not an error — it is optional. */
export function getEnvFileContent(db: DatabaseSync, projectName: string): FileResult {
    const stack = readStack(db, projectName);
    if (!stack) return { success: false, error: 'Stack not found', content: null, path: null };

    const path = resolveEnvFilePath(stack);
    if (!path || !existsSync(path)) {
        return { success: true, error: null, content: '', path };
    }

    try {
        return { success: true, error: null, content: readFileSync(path, 'utf8'), path };
    } catch {
        return { success: false, error: 'Failed to read env file', content: null, path };
    }
}

/**
 * `ComposeManager::saveComposeFileContent`. Call within `DatabaseService.write()`
 * — it both reads the stack row and, via `snapshotVersion`, may insert into
 * `compose_file_versions`.
 */
export function saveComposeFileContent(
    db: DatabaseSync,
    projectName: string,
    content: string
): { success: boolean; error: string | null; path: string | null } {
    const stack = readStack(db, projectName);
    if (!stack) return { success: false, error: 'Stack not found', path: null };

    const path = resolveComposeFilePath(stack);
    if (!path) return { success: false, error: 'Cannot determine compose file path', path: null };

    snapshotIfExists(db, projectName, 'compose', path);

    return writeFile(path, content);
}

/** `ComposeManager::saveEnvFileContent`. Same shape as the compose-file save. */
export function saveEnvFileContent(
    db: DatabaseSync,
    projectName: string,
    content: string
): { success: boolean; error: string | null; path: string | null } {
    const stack = readStack(db, projectName);
    if (!stack) return { success: false, error: 'Stack not found', path: null };

    const path = resolveEnvFilePath(stack);
    if (!path) return { success: false, error: 'Cannot determine env file path', path: null };

    // PHP additionally requires the existing content be non-empty before
    // snapshotting an env file (`$currentContent !== '' `), unlike the
    // compose-file save. ComposeManager.php:1091. Ported as-is.
    if (existsSync(path)) {
        const current = safeRead(path);
        if (current !== null && current !== '') {
            snapshotVersion(db, projectName, 'env', path, current);
        }
    }

    return writeFile(path, content);
}

function snapshotIfExists(db: DatabaseSync, projectName: string, fileType: 'compose' | 'env', path: string): void {
    if (!existsSync(path)) return;
    const current = safeRead(path);
    if (current !== null) snapshotVersion(db, projectName, fileType, path, current);
}

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function writeFile(path: string, content: string): { success: boolean; error: string | null; path: string } {
    try {
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(path, content, 'utf8');
        return { success: true, error: null, path };
    } catch {
        return { success: false, error: 'Failed to write file', path };
    }
}

/**
 * `ComposeManager::snapshotVersion`. A no-op when the content is unchanged
 * from the latest snapshot (by hash), or when `working_dir` is too weak a
 * containment base to trust — it is label-derived and can be empty or `/`,
 * either of which would make `.versions` resolve outside the stack entirely.
 */
function snapshotVersion(
    db: DatabaseSync,
    projectName: string,
    fileType: 'compose' | 'env',
    _sourcePath: string,
    content: string
): void {
    const hash = createHash('md5').update(content).digest('hex');

    const latest = db
        .prepare(
            `SELECT content_hash FROM compose_file_versions
             WHERE project_name = ? AND file_type = ?
             ORDER BY id DESC LIMIT 1`
        )
        .get(projectName, fileType) as { content_hash?: string } | undefined;
    if (latest && latest.content_hash === hash) return;

    const stack = db
        .prepare('SELECT working_dir FROM compose_stacks WHERE project_name = ?')
        .get(projectName) as { working_dir?: string | null } | undefined;
    if (!stack) return;

    const versionsDir = normalizePath(`${(stack.working_dir ?? '').replace(/\/+$/, '')}/.versions`);
    if (versionsDir === null || !pathIsWithin(versionsDir, stack.working_dir)) return;

    if (!existsSync(versionsDir)) mkdirSync(versionsDir, { recursive: true });

    const timestamp = nowSeconds();
    const ext = fileType === 'compose' ? 'yml' : 'env';
    const versionFilename = `${timestamp}-${fileType}.${ext}`;
    const versionPath = `${versionsDir}/${versionFilename}`;

    try {
        writeFileSync(versionPath, content, 'utf8');
    } catch {
        return;
    }

    db.prepare(
        `INSERT INTO compose_file_versions (project_name, file_type, file_path, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`
    ).run(projectName, fileType, `.versions/${versionFilename}`, hash, timestamp);

    pruneVersions(db, projectName, fileType);
}

/** `ComposeManager::pruneVersions`. Deletes the oldest rows/files past `compose_max_versions`. */
function pruneVersions(db: DatabaseSync, projectName: string, fileType: 'compose' | 'env'): void {
    const maxSetting = db
        .prepare("SELECT value FROM settings WHERE key = 'compose_max_versions'")
        .get() as { value?: string } | undefined;
    const max = maxSetting ? Number.parseInt(maxSetting.value ?? '10', 10) : 10;
    if (max <= 0) return;

    const count = Number(
        (db
            .prepare(
                'SELECT COUNT(*) AS n FROM compose_file_versions WHERE project_name = ? AND file_type = ?'
            )
            .get(projectName, fileType) as { n: number }).n
    );
    if (count <= max) return;

    const stack = db
        .prepare('SELECT working_dir FROM compose_stacks WHERE project_name = ?')
        .get(projectName) as { working_dir?: string | null } | undefined;

    const excess = db
        .prepare(
            `SELECT id, file_path FROM compose_file_versions
             WHERE project_name = ? AND file_type = ?
             ORDER BY id ASC LIMIT ?`
        )
        .all(projectName, fileType, count - max) as { id: number; file_path: string }[];

    for (const row of excess) {
        if (stack) {
            // `file_path` is plugin-written and timestamp-based, so this
            // should never fire in normal operation — which is exactly why
            // it is cheap. ComposeManager.php:1246-1249.
            const fullPath = resolveAgainst(row.file_path, stack.working_dir);
            if (fullPath !== null && pathIsWithin(fullPath, stack.working_dir)) {
                try {
                    unlinkSync(fullPath);
                } catch {
                    // Best effort, matching PHP's @unlink.
                }
            }
        }
        db.prepare('DELETE FROM compose_file_versions WHERE id = ?').run(row.id);
    }
}

/** `ComposeManager::getFileVersions`. */
export function getFileVersions(
    db: DatabaseSync,
    projectName: string,
    fileType: string
): { success: boolean; error: string | null; versions: FileVersionRow[] } {
    if (fileType !== 'compose' && fileType !== 'env') {
        return { success: false, error: 'Invalid file type', versions: [] };
    }

    const rows = db
        .prepare(
            `SELECT id, file_type, file_path, content_hash, created_at
             FROM compose_file_versions
             WHERE project_name = ? AND file_type = ?
             ORDER BY created_at DESC`
        )
        .all(projectName, fileType) as unknown as FileVersionRow[];

    return { success: true, error: null, versions: rows };
}

/**
 * `ComposeManager::getFileVersionContent`. Reachable from a plain GET, so —
 * unlike the live compose/env file readers above — this DOES check
 * containment even though both `file_path` and `working_dir` are
 * plugin-written, per the comment on ComposeManager.php:1291-1294.
 */
export function getFileVersionContent(
    db: DatabaseSync,
    projectName: string,
    versionId: number
): { success: boolean; error: string | null; version: FileVersionDetail | null } {
    const version = db
        .prepare(
            `SELECT v.id, v.file_type, v.file_path, v.content_hash, v.created_at, s.working_dir
             FROM compose_file_versions v
             JOIN compose_stacks s ON s.project_name = v.project_name
             WHERE v.id = ? AND v.project_name = ?`
        )
        .get(versionId, projectName) as
        | (FileVersionRow & { working_dir: string | null })
        | undefined;

    if (!version) return { success: false, error: 'Version not found', version: null };

    const fullPath = resolveAgainst(version.file_path, version.working_dir);
    if (fullPath === null || !pathIsWithin(fullPath, version.working_dir)) {
        return { success: false, error: 'Version file path is not valid', version: null };
    }

    if (!existsSync(fullPath)) {
        return { success: false, error: 'Version file missing from disk', version: null };
    }

    try {
        const content = readFileSync(fullPath, 'utf8');
        return {
            success: true,
            error: null,
            version: {
                id: version.id,
                file_type: version.file_type,
                file_path: version.file_path,
                content_hash: version.content_hash,
                created_at: version.created_at,
                content,
            },
        };
    } catch {
        return { success: false, error: 'Failed to read version file', version: null };
    }
}

/** `ComposeManager::restoreFileVersion`. Call within `DatabaseService.write()`. */
export function restoreFileVersion(
    db: DatabaseSync,
    projectName: string,
    versionId: number
): { success: boolean; error: string | null; path: string | null } {
    const result = getFileVersionContent(db, projectName, versionId);
    if (!result.success || result.version === null) {
        return { success: false, error: result.error, path: null };
    }

    return result.version.file_type === 'compose'
        ? saveComposeFileContent(db, projectName, result.version.content)
        : saveEnvFileContent(db, projectName, result.version.content);
}
