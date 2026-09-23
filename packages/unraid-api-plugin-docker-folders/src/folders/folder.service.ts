import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';

import { DatabaseService, type Row } from '../db/database.service.js';
import { EventBusService } from '../events/event-bus.service.js';
import { nowSeconds } from '../util/time.js';
import {
    DockerFolder,
    DockerFolderCreateInput,
    DockerFolderLayout,
    DockerFolderMember,
    DockerFolderUpdateInput,
    DockerFoldersInfo,
    SORT_MODES,
} from './folder.model.js';

export const PLUGIN_VERSION = '0.0.4';

type SortMode = (typeof SORT_MODES)[number];

/** Matches FolderManager.php's default when the column predates the migration. */
const DEFAULT_SORT_MODE: SortMode = 'manual';

/** A container name is stored in a TEXT column; PHP's endpoint caps it here. */
const MAX_CONTAINER_NAME = 255;

function isSortMode(mode: unknown): mode is SortMode {
    return SORT_MODES.includes(mode as SortMode);
}

/**
 * One past the highest position, so a new row lands at the end.
 *
 * MAX over no rows is null, and PHP's `?? -1` then makes the first position 0.
 */
function nextPosition(db: DatabaseSync, sql: string, ...params: unknown[]): number {
    const row = db.prepare(sql).get(...(params as never[])) as { value?: number | null } | undefined;
    return (row?.value ?? -1) + 1;
}

function toMember(row: Row): DockerFolderMember {
    return {
        id: Number(row.id),
        containerId: String(row.container_id),
        containerName: String(row.container_name),
        position: Number(row.position ?? 0),
    };
}

/**
 * Thrown from the service rather than answered as null, so the resolvers stay
 * pure delegation. The API turns it into a GraphQL error whose message the
 * frontend reads the same way it reads the message out of PHP's 404 body.
 */
function notFound(id: number): NotFoundException {
    return new NotFoundException(`No folder with id ${id}`);
}

/**
 * The folder read and write paths, ported from `FolderManager.php`.
 *
 * Ported rather than reinvented on purpose. PHP stays the default backend and
 * both write the same file, so a folder created in one mode has to look
 * identical to one created in the other: the same default name, the same
 * position arithmetic, the same fallback when a sort mode is not recognized.
 *
 * Every operation takes exactly one database handle, whether it reads or
 * writes, including the read-back that answers with the changed folder. The
 * PHP class reads folders and their members with one query each in a loop,
 * which costs nothing there because its connection is a singleton. Here a
 * handle is opened per call, so the statements are gathered instead.
 *
 * Two differences from PHP, both deliberate. Each write runs in one
 * transaction, including the Compose-sync bookkeeping that `folders.php` does
 * in a second call after the manager returns, so a crash between the two
 * cannot leave a container half moved. And a write announces itself from
 * `mutate()` rather than from each method or from the resolver, so a mutation
 * added later cannot forget to, and one that rolled back cannot announce a
 * change that did not happen.
 */
@Injectable()
export class FolderService implements OnModuleInit {
    private readonly logger = new Logger(FolderService.name);

    constructor(
        private readonly db: DatabaseService,
        private readonly events: EventBusService
    ) {}

    onModuleInit() {
        const readable = this.db.isReadable();
        this.logger.log(
            `Docker Folders loaded. Database ${this.db.path} is ${readable ? 'readable' : 'UNREADABLE'}.`
        );
    }

    getInfo(): DockerFoldersInfo {
        return {
            version: PLUGIN_VERSION,
            databasePath: this.db.path,
            databaseReadable: this.db.isReadable(),
        };
    }

    getLayout(): DockerFolderLayout {
        return this.db.read((db) => ({
            folders: this.readFolders(db),
            unfolderedOrder: this.readUnfolderedOrder(db),
        }));
    }

    getFolders(): DockerFolder[] {
        return this.db.read((db) => this.readFolders(db));
    }

    getUnfolderedOrder(): string[] {
        return this.db.read((db) => this.readUnfolderedOrder(db));
    }

    /** One folder with its members, or null when the id is unknown. */
    getFolder(id: number): DockerFolder | null {
        return this.db.read((db) => this.readFolder(db, id));
    }

    createFolder(input: DockerFolderCreateInput): DockerFolder {
        const now = nowSeconds();

        return this.mutate('create', (db) => {
            const next = nextPosition(db, 'SELECT MAX(position) AS value FROM folders');
            const result = db
                .prepare(
                    `INSERT INTO folders
                        (name, icon, color, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
                )
                .run(
                    input.name ?? 'New Folder',
                    input.icon ?? null,
                    input.color ?? null,
                    next,
                    input.composeProject ?? null,
                    isSortMode(input.sortMode) ? input.sortMode : DEFAULT_SORT_MODE,
                    now,
                    now
                );
            return this.requireFolder(db, Number(result.lastInsertRowid));
        });
    }

    updateFolder(id: number, input: DockerFolderUpdateInput): DockerFolder {
        return this.mutate('update', (db) => {
            this.requireExists(db, id);

            // Column names come from this fixed list, never from the request.
            const assignments: string[] = ['updated_at = ?'];
            const values: unknown[] = [nowSeconds()];

            const set = (column: string, value: unknown) => {
                assignments.push(`${column} = ?`);
                values.push(value);
            };

            // A null counts as an omission, because PHP's handlers use isset()
            // and a null never reaches an UPDATE there either.
            if (input.name !== undefined && input.name !== null) set('name', input.name);
            if (input.icon !== undefined && input.icon !== null) set('icon', input.icon);
            if (input.color !== undefined && input.color !== null) set('color', input.color);
            if (input.position !== undefined && input.position !== null) {
                set('position', Math.trunc(input.position));
            }
            if (input.collapsed !== undefined && input.collapsed !== null) {
                set('collapsed', input.collapsed ? 1 : 0);
            }
            if (isSortMode(input.sortMode)) set('sort_mode', input.sortMode);

            db.prepare(`UPDATE folders SET ${assignments.join(', ')} WHERE id = ?`).run(
                ...([...values, id] as never[])
            );
            return this.requireFolder(db, id);
        });
    }

    /** The folder's members go with it, through the ON DELETE CASCADE. */
    deleteFolder(id: number): void {
        this.mutate('delete', (db) => {
            // The DELETE reports whether the row was there, so there is no
            // reason to look it up first.
            if (db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes === 0) {
                throw notFound(id);
            }
        });
    }

    /**
     * Put a container in a folder, taking it out of whichever one it was in.
     *
     * A container already in this folder keeps its row: deleting and
     * reinserting would send it to the end and renumber the folder. Its
     * `containerId` is refreshed even so, because `reorderContainers` matches
     * on that column and a stale id would make drag-and-drop skip the row.
     */
    addContainerToFolder(
        folderId: number,
        containerId: string,
        containerName: string
    ): DockerFolder {
        return this.mutate('add_container', (db) => {
            this.requireExists(db, folderId);

            const existing = db
                .prepare('SELECT folder_id FROM container_folders WHERE container_name = ?')
                .get(containerName) as { folder_id?: number } | undefined;

            if (existing !== undefined && Number(existing.folder_id) === folderId) {
                db.prepare(
                    'UPDATE container_folders SET container_id = ? WHERE container_name = ?'
                ).run(containerId, containerName);
            } else {
                const next = nextPosition(
                    db,
                    'SELECT MAX(position) AS value FROM container_folders WHERE folder_id = ?',
                    folderId
                );
                // By name, because that is the stable key across a recreate.
                db.prepare('DELETE FROM container_folders WHERE container_name = ?').run(
                    containerName
                );
                db.prepare(
                    `INSERT INTO container_folders (container_id, container_name, folder_id, position)
                     VALUES (?, ?, ?, ?)`
                ).run(containerId, containerName, folderId, next);
            }

            // Let the Compose sync manage this container again. The user just
            // said where it belongs by putting it somewhere.
            db.prepare('DELETE FROM compose_sync_exclusions WHERE container_name = ?').run(
                containerName
            );

            return this.requireFolder(db, folderId);
        });
    }

    /**
     * Take a container out of its folder.
     *
     * The exclusion row is the point: `syncComposeStacks` puts every
     * unassigned Compose container back into its stack folder on each
     * container list load, so without it a removal undoes itself.
     */
    removeContainerFromFolder(containerName: string): boolean {
        this.mutate('remove_container', (db) => {
            db.prepare('DELETE FROM container_folders WHERE container_name = ?').run(containerName);
            db.prepare(
                'INSERT OR REPLACE INTO compose_sync_exclusions (container_name, created_at) VALUES (?, ?)'
            ).run(containerName, nowSeconds());
        });
        return true;
    }

    /**
     * Drop every trace of a container that is gone.
     *
     * `containers.php` calls `FolderManager::removeContainerByName` after a
     * successful removal, and this is that call. It is deliberately not
     * `removeContainerFromFolder`: no exclusion row is written, because there
     * is no Compose sync left to fight once the container does not exist, and
     * the saved unfoldered order loses the name as well.
     */
    forgetContainer(containerName: string): void {
        this.mutate('forget_container', (db) => {
            db.prepare('DELETE FROM container_folders WHERE container_name = ?').run(containerName);
            db.prepare('DELETE FROM unfoldered_order WHERE container_name = ?').run(containerName);
        });
    }

    /** An id that is not in this folder is ignored, as it is in PHP. */
    reorderContainers(folderId: number, containerIds: string[]): DockerFolder {
        return this.mutate('reorder_containers', (db) => {
            this.requireExists(db, folderId);

            const update = db.prepare(
                'UPDATE container_folders SET position = ? WHERE folder_id = ? AND container_id = ?'
            );
            containerIds.forEach((containerId, position) => {
                update.run(position, folderId, containerId);
            });

            return this.requireFolder(db, folderId);
        });
    }

    reorderFolders(folderIds: number[]): boolean {
        this.mutate('reorder', (db) => {
            const update = db.prepare('UPDATE folders SET position = ? WHERE id = ?');
            folderIds.forEach((folderId, position) => {
                update.run(position, folderId);
            });
        });
        return true;
    }

    /**
     * Replace the manual order of the containers that are in no folder.
     *
     * The client sends the whole list in display order, so a name that is
     * absent loses its row and falls back to the state-first default. Empty
     * names and duplicates are skipped, because `container_name` is the
     * primary key, and positions stay contiguous from zero.
     */
    setUnfolderedOrder(containerNames: string[]): string[] {
        const tooLong = containerNames.find((name) => name.length > MAX_CONTAINER_NAME);
        if (tooLong !== undefined) {
            throw new Error(`Container names must be at most ${MAX_CONTAINER_NAME} characters`);
        }

        return this.mutate('reorder_unfoldered', (db) => {
            db.prepare('DELETE FROM unfoldered_order').run();
            const insert = db.prepare(
                'INSERT INTO unfoldered_order (container_name, position) VALUES (?, ?)'
            );
            const seen = new Set<string>();
            let position = 0;
            for (const name of containerNames) {
                if (name === '' || seen.has(name)) continue;
                seen.add(name);
                insert.run(name, position);
                position++;
            }
            return this.readUnfolderedOrder(db);
        });
    }

    /**
     * The export file, ported from `FolderManager::exportConfiguration`.
     *
     * Built key for key in PHP's order, so a file exported from either backend
     * reads the same and imports into the other. `exported_at` is ISO 8601
     * with the server's offset, which is what PHP's `date('c')` writes.
     */
    exportConfiguration(): FolderExportFile {
        return {
            version: '1.0.0',
            exported_at: isoWithOffset(new Date()),
            folders: this.getFolders().map((folder) => ({
                name: folder.name,
                icon: folder.icon,
                color: folder.color,
                position: folder.position,
                sort_mode: folder.sortMode ?? DEFAULT_SORT_MODE,
                containers: folder.containers.map((c) => ({ id: c.containerId, name: c.containerName })),
            })),
        };
    }

    /**
     * Load an export file, ported from `FolderManager::importConfiguration`.
     *
     * As lenient as the PHP about shape, on purpose. The input is a file a
     * user picked, possibly written by an older version, so a folder with no
     * name becomes "Imported Folder" and unknown keys are ignored rather than
     * rejected. Every folder is created new; nothing existing is merged or
     * replaced, as in PHP.
     *
     * One transaction for the whole file, so a bad entry halfway through
     * leaves nothing behind. Membership moves go through the same rule as a
     * drag, a container leaving whatever folder it was in, but deliberately
     * without clearing a Compose-sync exclusion: `FolderManager` does not, and
     * only the interactive add on the folders endpoint does.
     */
    importConfiguration(config: unknown): FolderImportResult {
        const result: FolderImportResult = {
            success: true,
            folders_created: 0,
            containers_assigned: 0,
            errors: [],
        };

        const folders = (config as { folders?: unknown } | null)?.folders;
        if (!Array.isArray(folders)) {
            return { ...result, success: false, errors: ['Invalid configuration format'] };
        }

        try {
            this.db.write((db) => {
                const now = nowSeconds();
                for (const raw of folders) {
                    const entry = (raw ?? {}) as Record<string, unknown>;
                    const position = nextPosition(db, 'SELECT MAX(position) AS value FROM folders');
                    const sortMode = typeof entry.sort_mode === 'string' && isSortMode(entry.sort_mode)
                        ? entry.sort_mode
                        : DEFAULT_SORT_MODE;
                    const folderId = Number(
                        db
                            .prepare(
                                `INSERT INTO folders
                                    (name, icon, color, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`
                            )
                            .run(
                                // PHP's `??`: only an absent or null name falls back.
                                scalarOr(entry.name, 'Imported Folder'),
                                scalarOr(entry.icon, null),
                                scalarOr(entry.color, null),
                                position,
                                sortMode,
                                now,
                                now
                            ).lastInsertRowid
                    );
                    result.folders_created += 1;

                    const members = Array.isArray(entry.containers) ? entry.containers : [];
                    for (const member of members) {
                        const m = (member ?? {}) as Record<string, unknown>;
                        // PHP's `isset`: present and not null, any type.
                        if (m.id == null || m.name == null) continue;
                        const id = String(m.id);
                        const name = String(m.name);

                        // Listed twice in one folder: PHP's add finds it already
                        // there and only refreshes the id, keeping its position.
                        const here = db
                            .prepare('SELECT folder_id FROM container_folders WHERE container_name = ?')
                            .get(name) as { folder_id?: number } | undefined;
                        if (here !== undefined && Number(here.folder_id) === folderId) {
                            db.prepare('UPDATE container_folders SET container_id = ? WHERE container_name = ?').run(id, name);
                            result.containers_assigned += 1;
                            continue;
                        }

                        const at = nextPosition(
                            db,
                            'SELECT MAX(position) AS value FROM container_folders WHERE folder_id = ?',
                            folderId
                        );
                        db.prepare('DELETE FROM container_folders WHERE container_name = ?').run(name);
                        db.prepare(
                            `INSERT INTO container_folders (container_id, container_name, folder_id, position)
                             VALUES (?, ?, ?, ?)`
                        ).run(id, name, folderId, at);
                        result.containers_assigned += 1;
                    }
                }
            });
        } catch (error) {
            return {
                success: false,
                folders_created: 0,
                containers_assigned: 0,
                errors: [error instanceof Error ? error.message : String(error)],
            };
        }

        this.events.publish('folder', 'import');
        return result;
    }

    /**
     * Bring the folder tables in line with what Docker reports, the way
     * `containers.php` does on every container-list request.
     *
     * Two jobs, ported from `FolderManager::reconcileContainerIds` and
     * `syncComposeStacks`, and both are load-bearing rather than tidying:
     *
     * - Unraid gives a container a new id every time it is recreated, which
     *   every image update does. Memberships are keyed by name, but drag and
     *   drop reorders by id, so a stale id makes a recreated container
     *   impossible to move until this rewrites it.
     * - A Compose project gets a folder of its own, created on first sight,
     *   and its unassigned containers are put into it. A container the user
     *   deliberately took out stays out, through `compose_sync_exclusions`.
     *
     * One transaction where PHP uses several statements, so a crash part way
     * through cannot leave a stack folder with half its containers.
     *
     * Announces only when a folder or a membership actually changed. The PHP
     * publishes that as entity `folders`, which the frontend's dispatch table
     * never matches, so another tab only caught up on its poll; this uses
     * `folder`, which it does match. The `compose_stacks` bookkeeping is not
     * announced, matching PHP, which never counted it as a change.
     *
     * Reconciling never deletes anything. With an empty list, which is what a
     * Docker socket failure looks like, both halves are no-ops.
     */
    syncWithContainers(containers: readonly SyncContainer[]): boolean {
        const changed = this.db.write((db) => {
            reconcileIds(db, containers);
            return syncComposeProjects(db, containers);
        });

        if (changed) this.events.publish('folder', 'compose_sync');
        return changed;
    }

    /**
     * Run a write, then tell open tabs about it.
     *
     * The announcement belongs here rather than at each call site. A write that
     * threw has been rolled back and must not claim anything changed, and a
     * mutation added later cannot quietly skip the notification and leave every
     * other open tab stale until its 30-second poll.
     */
    private mutate<T>(action: string, work: (db: DatabaseSync) => T): T {
        const result = this.db.write(work);
        this.events.publish('folder', action);
        return result;
    }

    /** Cheaper than reading the folder when only its existence matters. */
    private requireExists(db: DatabaseSync, id: number): void {
        if (db.prepare('SELECT 1 FROM folders WHERE id = ?').get(id) === undefined) {
            throw notFound(id);
        }
    }

    private requireFolder(db: DatabaseSync, id: number): DockerFolder {
        const folder = this.readFolder(db, id);
        if (folder === null) throw notFound(id);
        return folder;
    }

    private readFolder(db: DatabaseSync, id: number): DockerFolder | null {
        const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Row | undefined;
        if (row === undefined) return null;
        const members = db
            .prepare('SELECT * FROM container_folders WHERE folder_id = ? ORDER BY position ASC')
            .all(id) as Row[];
        return this.toFolder(row, members.map(toMember));
    }

    private readFolders(db: DatabaseSync): DockerFolder[] {
        const members = this.readMembersByFolder(db);
        const rows = db
            .prepare('SELECT * FROM folders ORDER BY position ASC, name ASC')
            .all() as Row[];
        return rows.map((row) => this.toFolder(row, members.get(Number(row.id)) ?? []));
    }

    private readUnfolderedOrder(db: DatabaseSync): string[] {
        const rows = db
            .prepare('SELECT container_name FROM unfoldered_order ORDER BY position ASC')
            .all() as Row[];
        return rows.map((row) => String(row.container_name));
    }

    private readMembersByFolder(db: DatabaseSync): Map<number, DockerFolderMember[]> {
        const rows = db
            .prepare('SELECT * FROM container_folders ORDER BY folder_id ASC, position ASC')
            .all() as Row[];
        const grouped = new Map<number, DockerFolderMember[]>();
        for (const row of rows) {
            const folderId = Number(row.folder_id);
            const list = grouped.get(folderId) ?? [];
            list.push(toMember(row));
            grouped.set(folderId, list);
        }
        return grouped;
    }

    private toFolder(row: Row, containers: DockerFolderMember[]): DockerFolder {
        return {
            id: Number(row.id),
            name: String(row.name),
            icon: row.icon === null || row.icon === undefined ? null : String(row.icon),
            color: row.color === null || row.color === undefined ? null : String(row.color),
            position: Number(row.position ?? 0),
            // SQLite has no boolean type; the column stores 0 or 1.
            collapsed: Number(row.collapsed ?? 0) === 1,
            composeProject:
                row.compose_project === null || row.compose_project === undefined
                    ? null
                    : String(row.compose_project),
            sortMode: row.sort_mode ? String(row.sort_mode) : DEFAULT_SORT_MODE,
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
            containers,
        };
    }
}

/** The slice of a container the sync needs, whatever produced it. */
export interface SyncContainer {
    id: string;
    name: string;
    labels: Readonly<Record<string, string>>;
}

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';
const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';

/** The icon PHP gives a folder it creates for a Compose project. */
const COMPOSE_FOLDER_ICON = 'layer-group';

function reconcileIds(db: DatabaseSync, containers: readonly SyncContainer[]): void {
    const idByName = new Map<string, string>();
    for (const container of containers) {
        const name = container.name.replace(/^\//, '');
        if (name !== '') idByName.set(name, container.id);
    }

    const rows = db
        .prepare('SELECT id, container_id, container_name FROM container_folders')
        .all() as { id: number; container_id: string; container_name: string }[];

    const update = db.prepare('UPDATE container_folders SET container_id = ? WHERE id = ?');
    for (const row of rows) {
        const current = idByName.get(row.container_name);
        if (current !== undefined && current !== row.container_id) {
            update.run(current, row.id);
        }
    }
}

function syncComposeProjects(db: DatabaseSync, containers: readonly SyncContainer[]): boolean {
    const byProject = new Map<string, SyncContainer[]>();
    for (const container of containers) {
        const project = container.labels[COMPOSE_PROJECT_LABEL];
        if (project === undefined) continue;
        byProject.set(project, [...(byProject.get(project) ?? []), container]);
    }
    if (byProject.size === 0) return false;

    const folderByProject = new Map<string, number>();
    for (const row of db
        .prepare('SELECT id, compose_project FROM folders WHERE compose_project IS NOT NULL')
        .all() as { id: number; compose_project: string }[]) {
        folderByProject.set(row.compose_project, Number(row.id));
    }

    const assigned = new Set(
        (db.prepare('SELECT container_name FROM container_folders').all() as {
            container_name: string;
        }[]).map((row) => row.container_name)
    );
    const excluded = new Set(
        (db.prepare('SELECT container_name FROM compose_sync_exclusions').all() as {
            container_name: string;
        }[]).map((row) => row.container_name)
    );

    let changed = false;
    const now = nowSeconds();

    for (const [project, members] of byProject) {
        let folderId = folderByProject.get(project);
        if (folderId === undefined) {
            const position = nextPosition(db, 'SELECT MAX(position) AS value FROM folders');
            const result = db
                .prepare(
                    `INSERT INTO folders
                        (name, icon, color, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                     VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)`
                )
                .run(project, COMPOSE_FOLDER_ICON, position, project, DEFAULT_SORT_MODE, now, now);
            folderId = Number(result.lastInsertRowid);
            folderByProject.set(project, folderId);
            changed = true;
        }

        upsertComposeStack(db, project, members[0].labels, now);

        for (const container of members) {
            const name = container.name.replace(/^\//, '');
            if (assigned.has(name) || excluded.has(name)) continue;

            const position = nextPosition(
                db,
                'SELECT MAX(position) AS value FROM container_folders WHERE folder_id = ?',
                folderId
            );
            db.prepare(
                `INSERT INTO container_folders (container_id, container_name, folder_id, position)
                 VALUES (?, ?, ?, ?)`
            ).run(container.id, name, folderId, position);
            assigned.add(name);
            changed = true;
        }
    }

    return changed;
}

/**
 * Record where a stack lives, from its labels. Ported from
 * `ComposeManager::upsertStack`.
 *
 * An existing row keeps the user's own settings: only the two paths are
 * refreshed, and only when the labels carry them. `updated_at` is bumped on
 * every call, as the PHP does, even when nothing else changed. That is a write
 * on a read path which nothing appears to need, but it is kept so the two
 * backends leave the same row behind.
 *
 * These paths come from container labels, so they are attacker-influenced and
 * are stored as given. They are deliberately not checked against an allowed
 * root here: a stack lives wherever the user ran `docker compose up`, and
 * refusing the label would break the container list for those users. The
 * check belongs where a stored path is used to read or write a file.
 */
function upsertComposeStack(
    db: DatabaseSync,
    project: string,
    labels: Readonly<Record<string, string>>,
    now: number
): void {
    const workingDir = labels[COMPOSE_WORKING_DIR_LABEL] || null;
    const configFiles = labels[COMPOSE_CONFIG_FILES_LABEL] || null;
    const composeFile = configFiles === null ? null : configFiles.split(',')[0];

    const existing = db
        .prepare('SELECT project_name FROM compose_stacks WHERE project_name = ?')
        .get(project);

    if (existing === undefined) {
        db.prepare(
            `INSERT INTO compose_stacks
                (project_name, working_dir, compose_file, env_file, autostart,
                 autostart_force_recreate, description, imported_from, created_at, updated_at)
             VALUES (?, ?, ?, NULL, 0, 0, NULL, NULL, ?, ?)`
        ).run(project, workingDir, composeFile, now, now);
        return;
    }

    db.prepare(
        `UPDATE compose_stacks SET
            updated_at = ?,
            working_dir = COALESCE(?, working_dir),
            compose_file = COALESCE(?, compose_file)
         WHERE project_name = ?`
    ).run(now, workingDir, composeFile, project);
}

export interface FolderExportFile {
    version: string;
    exported_at: string;
    folders: {
        name: string;
        icon: string | null;
        color: string | null;
        position: number;
        sort_mode: string;
        containers: { id: string; name: string }[];
    }[];
}

export interface FolderImportResult {
    success: boolean;
    folders_created: number;
    containers_assigned: number;
    errors: string[];
}

/** A present scalar as a string, as PHP would store it; otherwise the fallback. */
function scalarOr<T extends string | null>(value: unknown, fallback: T): string | T {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return typeof value === 'boolean' ? (value ? '1' : '') : String(value);
    }
    return fallback;
}

/** PHP's `date('c')`: `2026-09-21T20:55:00-06:00`, in the server's zone. */
function isoWithOffset(at: Date): string {
    const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
    const offset = -at.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return (
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
        `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
        `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
    );
}
