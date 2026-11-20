import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { normalizePath, pathIsWithin, resolveAgainst, safePathComponent } from '../paths/paths.js';
import { nowSeconds } from '../util/time.js';
import type { ComposePathsConfig } from './compose-config.js';
import { PIN_FILE, nameFromFolder } from './compose-project-name.js';

/**
 * Merge or rename the rows an earlier import copied, so a stack is one row.
 * Ported from `ComposeManager::repairImportedStacks`; see its doc comment for
 * the rules, and `compose.service.ts` for the import that no longer copies.
 *
 * Runs inside the container-list sync of both backends, so it needs no
 * migration and no menu. On a server with no such row it reads one small query
 * and writes nothing. It never deletes a file. A failed write rolls the
 * repair back and leaves the rest of the sync alone.
 *
 * @returns true when anything was written
 */
export function repairImportedStacks(db: DatabaseSync, paths: ComposePathsConfig): boolean {
    const copies = importedCopies(db, paths.stacksDir);
    if (copies.length === 0) return false;

    const projectsDir = paths.pluginProjectsDir;
    const legacyOrigin = isFile(`${dirname(projectsDir)}/legacy-origin`);
    const plusInstalled = isFile(`${paths.pluginDir}/include/ProjectIdentity.php`);

    const copyNames = new Set(copies.map((copy) => copy.row.project_name));
    const all = db.prepare('SELECT * FROM compose_stacks').all() as unknown as StackRow[];
    const others = all.filter((row) => !copyNames.has(row.project_name));
    const taken = new Set(all.map((row) => row.project_name));

    const actions: Action[] = [];
    for (const copy of copies) {
        const row = copy.row;
        const sourcePath = `${projectsDir}/${copy.dir}`;
        const sourceDir = isDir(sourcePath) ? sourceDirOf(sourcePath) : null;

        const counterpart = findCounterpart(sourceDir, sourcePath, others);
        if (counterpart === false) continue; // two fit equally
        if (counterpart !== null) {
            actions.push({ type: 'merge', from: row, to: counterpart, versionPaths: new Map() });
            continue;
        }

        if (sourceDir === null || !copyMatchesSource(row, sourceDir)) continue;
        const rule = nameFromFolder({
            dirName: copy.dir,
            displayName: readMetadataFile(`${sourcePath}/name`),
            pinned: readMetadataFile(`${sourcePath}/${PIN_FILE}`),
            plusInstalled,
            legacyOrigin,
        });
        // The copy's own name is not "taken": the row is repointed in place.
        if (rule.name === null || (taken.has(rule.name) && rule.name !== row.project_name)) continue;
        taken.add(rule.name);
        actions.push({ type: 'rename', from: row, name: rule.name, sourceDir, versionPaths: new Map() });
    }

    if (actions.length === 0) return false;

    // Snapshot files are copied first. Nothing is deleted, and a copy that
    // already exists is left.
    for (const action of actions) {
        const toDir = action.type === 'merge' ? action.to.working_dir : action.sourceDir;
        action.versionPaths = carryVersionFiles(db, action.from, toDir);
    }

    db.exec('SAVEPOINT compose_import_repair');
    try {
        for (const action of actions) {
            if (action.type === 'merge') mergeStackRows(db, action.from, action.to, action.versionPaths);
            else renameStackRow(db, action.from, action.name, action.sourceDir, action.versionPaths);
        }
        db.exec('RELEASE compose_import_repair');
    } catch (error) {
        db.exec('ROLLBACK TO compose_import_repair');
        db.exec('RELEASE compose_import_repair');
        console.error(`Compose import repair failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    return true;
}

export interface StackRow {
    project_name: string;
    working_dir: string | null;
    compose_file: string | null;
    env_file: string | null;
    autostart: number;
    autostart_force_recreate: number;
    description: string | null;
    imported_from: string | null;
    created_at: number;
    updated_at: number;
}

type Action =
    | { type: 'merge'; from: StackRow; to: StackRow; versionPaths: Map<number, string> }
    | { type: 'rename'; from: StackRow; name: string; sourceDir: string; versionPaths: Map<number, string> };

/**
 * The directory a Compose Manager project's compose files live in: the folder
 * itself, or the target of its "indirect" file. Null when an indirect target
 * is missing or relative.
 */
export function sourceDirOf(projectPath: string): string | null {
    if (!existsSync(`${projectPath}/indirect`)) return projectPath;
    const raw = readMetadataFile(`${projectPath}/indirect`);
    const target = raw ? normalizePath(raw) : null;
    return target !== null && isDir(target) ? target : null;
}

/** Rows an earlier import made: `compose_plugin`, files in a copy under `stacksDir`. */
export function importedCopies(db: DatabaseSync, stacksDir: string): { row: StackRow; dir: string }[] {
    const base = normalizePath(stacksDir);
    if (base === null || base === '/') return [];
    const copies: { row: StackRow; dir: string }[] = [];
    const rows = db
        .prepare("SELECT * FROM compose_stacks WHERE imported_from = 'compose_plugin'")
        .all() as unknown as StackRow[];
    for (const row of rows) {
        const dir = typeof row.working_dir === 'string' ? normalizePath(row.working_dir) : null;
        if (dir === null || dir === base || !pathIsWithin(dir, base)) continue;
        copies.push({ row, dir: dir.slice(base.length + 1).split('/')[0] });
    }
    return copies;
}

/**
 * The row for the same Compose Manager stack as a copy row: the one that runs
 * from the stack's folder (or that folder's indirect target). A name match
 * alone never counts, because two stacks can sanitize to the same value.
 * Null when none fits; false when more than one does.
 */
function findCounterpart(
    sourceDir: string | null,
    sourcePath: string,
    others: readonly StackRow[]
): StackRow | false | null {
    const folders = new Set<string>();
    for (const path of [sourcePath, sourceDir]) {
        const normalized = path === null ? null : normalizePath(path);
        if (normalized !== null) folders.add(normalized);
    }

    const byFolder = others.filter((other) => {
        const dir = typeof other.working_dir === 'string' ? normalizePath(other.working_dir) : null;
        return dir !== null && folders.has(dir);
    });
    if (byFolder.length === 1) return byFolder[0];
    if (byFolder.length > 1) return false;
    return null;
}

/** Is the copy a row points at the same bytes as its source folder? Compose file, and .env when the copy has one. */
function copyMatchesSource(row: StackRow, sourceDir: string): boolean {
    const copyCompose = row.compose_file;
    if (typeof copyCompose !== 'string' || !isFile(copyCompose)) return false;
    const sourceCompose = `${sourceDir}/${basename(copyCompose)}`;
    if (!isFile(sourceCompose) || !sameBytes(copyCompose, sourceCompose)) return false;

    const copyEnv = typeof row.env_file === 'string' && row.env_file !== '' ? row.env_file : null;
    if (copyEnv !== null && isFile(copyEnv)) {
        const sourceEnv = `${sourceDir}/${basename(copyEnv)}`;
        return isFile(sourceEnv) && sameBytes(copyEnv, sourceEnv);
    }
    return true;
}

function sameBytes(a: string, b: string): boolean {
    try {
        // A size check first: most differing files are caught without reading either.
        return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
    } catch {
        return false;
    }
}

/**
 * Copy a stack's saved-version snapshot files from its old folder to the new
 * one, so the version rows still resolve after they move. The files stay where
 * they are. Returns version id -> file_path to store.
 */
function carryVersionFiles(db: DatabaseSync, fromRow: StackRow, toDirRaw: string | null): Map<number, string> {
    const paths = new Map<number, string>();
    const fromDir = typeof fromRow.working_dir === 'string' ? fromRow.working_dir : null;
    const toDir = typeof toDirRaw === 'string' ? normalizePath(toDirRaw) : null;
    if (fromDir === null || toDir === null || toDir === '/') return paths;

    const rows = db
        .prepare('SELECT id, file_path FROM compose_file_versions WHERE project_name = ?')
        .all(fromRow.project_name) as unknown as { id: number; file_path: string }[];
    for (const version of rows) {
        const src = resolveAgainst(version.file_path, fromDir);
        const name = basename(version.file_path);
        if (src === null || !pathIsWithin(src, fromDir) || !isFile(src) || safePathComponent(name) === null) continue;
        let rel = `.versions/${name}`;
        let dest = `${toDir}/${rel}`;
        if (isFile(dest) && !sameBytes(src, dest)) {
            rel = `.versions/${version.id}-${name}`;
            dest = `${toDir}/${rel}`;
        }
        try {
            mkdirSync(`${toDir}/.versions`, { recursive: true });
            if (!isFile(dest)) copyFileSync(src, dest);
        } catch {
            continue;
        }
        paths.set(Number(version.id), rel);
    }
    return paths;
}

function moveVersionFiles(db: DatabaseSync, to: string, versionPaths: Map<number, string>): void {
    for (const [id, path] of versionPaths) {
        db.prepare('UPDATE compose_file_versions SET project_name = ?, file_path = ? WHERE id = ?').run(to, path, id);
    }
}

/**
 * Move everything that hangs on the stack `from` to the stack named `to`. The
 * row `to` must already exist (`compose_file_versions` has a foreign key to it).
 */
function moveStackReferences(db: DatabaseSync, from: string, to: string, versionPaths: Map<number, string>): void {
    db.prepare("UPDATE schedules SET target_id = ? WHERE target_type = 'stack' AND target_id = ?").run(to, from);

    moveVersionFiles(db, to, versionPaths);
    // Rows whose file could not be carried keep their path and still move.
    db.prepare('UPDATE compose_file_versions SET project_name = ? WHERE project_name = ?').run(to, from);

    const folders = db.prepare('SELECT id FROM folders WHERE compose_project = ?').all(from) as unknown as { id: number }[];
    for (const folder of folders) {
        const kept = db.prepare('SELECT id FROM folders WHERE compose_project = ?').get(to);
        if (kept === undefined) {
            db.prepare('UPDATE folders SET compose_project = ?, updated_at = ? WHERE id = ?').run(to, nowSeconds(), folder.id);
            continue;
        }
        const members = db.prepare('SELECT COUNT(*) AS n FROM container_folders WHERE folder_id = ?').get(folder.id) as {
            n: number;
        };
        if (Number(members.n) === 0) {
            db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
        } else {
            // Containers the user put there stay there, as an ordinary folder.
            db.prepare('UPDATE folders SET compose_project = NULL, updated_at = ? WHERE id = ?').run(nowSeconds(), folder.id);
        }
    }
}

function mergeStackRows(db: DatabaseSync, from: StackRow, to: StackRow, versionPaths: Map<number, string>): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (to.imported_from !== 'compose_plugin') {
        // So the import prompt stays away once the copy row is gone.
        sets.push("imported_from = 'compose_plugin'");
    }
    if (!to.description && from.description) {
        sets.push('description = ?');
        values.push(from.description);
    }
    if (!to.autostart && from.autostart) sets.push('autostart = 1');
    if (!to.autostart_force_recreate && from.autostart_force_recreate) sets.push('autostart_force_recreate = 1');
    if (sets.length > 0) {
        db.prepare(`UPDATE compose_stacks SET ${sets.join(', ')}, updated_at = ? WHERE project_name = ?`).run(
            ...values,
            nowSeconds(),
            to.project_name
        );
    }

    moveStackReferences(db, from.project_name, to.project_name, versionPaths);
    db.prepare('DELETE FROM compose_stacks WHERE project_name = ?').run(from.project_name);
}

function renameStackRow(
    db: DatabaseSync,
    from: StackRow,
    newName: string,
    sourceDir: string,
    versionPaths: Map<number, string>
): void {
    const now = nowSeconds();
    const composeFile = `${sourceDir}/${basename(String(from.compose_file))}`;
    if (newName === from.project_name) {
        db.prepare(
            'UPDATE compose_stacks SET working_dir = ?, compose_file = ?, env_file = NULL, updated_at = ? WHERE project_name = ?'
        ).run(sourceDir, composeFile, now, newName);
        moveVersionFiles(db, newName, versionPaths);
        return;
    }
    db.prepare(
        `INSERT INTO compose_stacks
            (project_name, working_dir, compose_file, env_file, autostart,
             autostart_force_recreate, description, imported_from, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'compose_plugin', ?, ?)`
    ).run(newName, sourceDir, composeFile, from.autostart, from.autostart_force_recreate, from.description, from.created_at, now);
    moveStackReferences(db, from.project_name, newName, versionPaths);
    db.prepare('DELETE FROM compose_stacks WHERE project_name = ?').run(from.project_name);
}

// ─── small fs helpers ──────────────────────────────────────────────────

export function readMetadataFile(path: string): string | null {
    if (!existsSync(path)) return null;
    try {
        return readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}
