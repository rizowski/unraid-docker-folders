import { statSync } from 'node:fs';
import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read and write access to the plugin's SQLite database.
 *
 * The PHP backend owns this file and is still the default, so both backends
 * must use the same rows or switching modes loses work. `node:sqlite` is built
 * into node 22, so it needs no compiler on a box that has none, and it is a
 * real SQLite build that understands the WAL journal PHP runs in. A WASM build
 * cannot see pages that PHP has written to `data.db-wal` and not yet
 * checkpointed.
 *
 * One handle serves a burst of calls, then closes once the plugin goes quiet.
 * See IDLE_CLOSE_MS for why it is neither per call nor held for good.
 */
export const DEFAULT_DB_PATH = '/boot/config/plugins/unraid-docker-folders-modern/data.db';

/** Overrides the database path. Only the tests supply one. */
export const DB_PATH_TOKEN = 'DOCKER_FOLDERS_DB_PATH';

/**
 * How long any handle waits for a lock before it gives up.
 *
 * `Database.php` calls `busyTimeout(5000)` on its one connection, which covers
 * its reads as well as its writes, so this matches it on both paths. Both
 * numbers describe the same contention and the two backends should behave the
 * same way under it. Measured on Unraid 7.3.2: with the PRAGMA set, a node
 * writer waits out a PHP `BEGIN IMMEDIATE` and then commits. Without it, the
 * same write fails at once with "database is locked".
 *
 * Readers need it too, which is not obvious under WAL, where a reader does not
 * block on a writer. They need it because a checkpoint does take an exclusive
 * lock, and SQLite checkpoints on its own once the WAL passes a thousand
 * pages, which a burst of PHP writes reaches. Seen on tower: the first load of
 * the folder page in GraphQL mode answered "database is locked" and rendered
 * no folders, while `containers.php` was doing its reconcile-and-sync write on
 * the same request. A reload a second later was fine, which is what an
 * unwaited lock looks like.
 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * How long the shared handle stays open after its last use.
 *
 * Closing a handle is the expensive part, not opening it. `/boot` is a vfat
 * USB stick mounted with `flush`, and the close of the last connection
 * checkpoints the WAL and deletes it, which waits on the stick. Measured on
 * tower: open 0.1ms, query 0.3ms, close 205 to 310ms. `node:sqlite` is
 * synchronous, so each close also stalls the whole Unraid API for that long.
 * With a handle per call, the Folders page load made about a dozen closes and
 * its queries queued behind each other.
 *
 * Closing when idle, rather than holding the handle for good, keeps the file
 * on disk the way PHP leaves it. PHP opens one connection per request and
 * closes it at the end, so between bursts the database has no open
 * connection, the WAL is checkpointed into `data.db` and removed, and a plain
 * `cp data.db` (the .plg's pre-upgrade and uninstall backups do this) copies
 * every committed write. A handle held for good would leave commits in the WAL
 * that such a copy misses, and a `cp` restore over a file the plugin still has
 * open could have that WAL replayed onto the wrong database.
 */
const IDLE_CLOSE_MS = 2000;

export type Row = Record<string, unknown>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
    private readonly logger = new Logger(DatabaseService.name);
    private handle: DatabaseSync | null = null;
    /** The file the handle has open, so a replaced file is noticed. */
    private handleFile: { dev: number; ino: number } | null = null;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Calls in progress on the handle, counting nested ones. */
    private depth = 0;
    /** True while a `write` transaction is open. */
    private inWrite = false;

    constructor(
        @Optional() @Inject(DB_PATH_TOKEN) private readonly dbPath: string = DEFAULT_DB_PATH
    ) {}

    get path(): string {
        return this.dbPath;
    }

    /** Whether the shared handle is open. For tests. */
    get isOpen(): boolean {
        return this.handle !== null;
    }

    onModuleDestroy(): void {
        this.closeHandle();
    }

    /** True when the database exists and answers a query. */
    isReadable(): boolean {
        try {
            this.query('SELECT 1');
            return true;
        } catch (error) {
            this.logger.warn(`Cannot read ${this.dbPath}: ${String(error)}`);
            return false;
        }
    }

    /**
     * Run `work` read-only.
     *
     * `PRAGMA query_only` gives the shared handle the guarantee a read-only
     * handle used to: a statement that writes fails. A read nested inside a
     * `write` runs in that write's transaction, as it must.
     *
     * The busy timeout is set on the handle, for reads as well as writes. See
     * BUSY_TIMEOUT_MS: a reader that meets a checkpoint and does not wait
     * fails outright, and the page then shows no folders at all.
     */
    read<T>(work: (db: DatabaseSync) => T): T {
        return this.withHandle((db) => {
            // Inside a write it shares the transaction. Inside another read
            // the guard is already on, and only the outermost read lifts it.
            if (this.inWrite || this.depth > 1) return work(db);
            db.exec('PRAGMA query_only = ON');
            try {
                return work(db);
            } finally {
                db.exec('PRAGMA query_only = OFF');
            }
        });
    }

    /** Run one read-only statement and return every row. */
    query(sql: string, params: unknown[] = []): Row[] {
        return this.read((db) => db.prepare(sql).all(...(params as never[])) as Row[]);
    }

    /**
     * Run `work` inside one transaction, then commit it, or roll it back and
     * rethrow.
     *
     * `BEGIN IMMEDIATE` rather than a plain `BEGIN`, because under WAL a
     * deferred transaction that reads and then writes can fail with
     * SQLITE_BUSY_SNAPSHOT when another writer committed in between, and the
     * busy timeout does not retry that one. Taking the write lock up front
     * turns the race into a wait.
     *
     * No transaction is left open between calls, so the shared handle never
     * holds a snapshot that would stop PHP's checkpoints.
     */
    write<T>(work: (db: DatabaseSync) => T): T {
        return this.withHandle((db) => {
            if (this.inWrite) return work(db);
            // A write reached from inside a read: lift the read's guard for
            // the transaction and put it back after.
            const wasQueryOnly = this.depth > 1;
            if (wasQueryOnly) db.exec('PRAGMA query_only = OFF');
            this.inWrite = true;
            try {
                db.exec('BEGIN IMMEDIATE');
                try {
                    const result = work(db);
                    db.exec('COMMIT');
                    return result;
                } catch (error) {
                    if (db.isTransaction) db.exec('ROLLBACK');
                    throw error;
                }
            } finally {
                this.inWrite = false;
                if (wasQueryOnly) db.exec('PRAGMA query_only = ON');
            }
        });
    }

    private withHandle<T>(work: (db: DatabaseSync) => T): T {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const db = this.acquire();
        this.depth++;
        try {
            return work(db);
        } catch (error) {
            // An I/O or corruption error can leave the handle unusable, and a
            // file replaced under it shows up the same way. Start fresh next
            // call. A plain SQL error (a constraint, a missing row) does not.
            if (this.depth === 1 && isHandleFault(error)) this.closeHandle();
            throw error;
        } finally {
            this.depth--;
            if (this.depth === 0 && this.handle) this.scheduleIdleClose();
        }
    }

    /**
     * The shared handle, opened if needed. Reopened when `data.db` is no longer
     * the file it has open: the .plg restores a backup with `cp`, and a
     * reinstall can recreate the file. Only checked between calls, never in
     * the middle of one.
     */
    private acquire(): DatabaseSync {
        if (this.handle && this.depth === 0) {
            const current = fileIdentity(this.dbPath);
            if (!current || current.dev !== this.handleFile?.dev || current.ino !== this.handleFile?.ino) {
                this.closeHandle();
            }
        }
        if (this.handle) return this.handle;

        const db = new DatabaseSync(this.dbPath);
        try {
            db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
            // Set explicitly, the way `Database.php` does. Deleting a folder
            // relies on the ON DELETE CASCADE in `container_folders`.
            db.exec('PRAGMA foreign_keys = ON');
        } catch (error) {
            db.close();
            throw error;
        }
        this.handle = db;
        this.handleFile = fileIdentity(this.dbPath);
        return db;
    }

    private scheduleIdleClose(): void {
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null;
            if (this.depth === 0) this.closeHandle();
        }, IDLE_CLOSE_MS);
        this.idleTimer.unref?.();
    }

    private closeHandle(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        const db = this.handle;
        this.handle = null;
        this.handleFile = null;
        if (!db) return;
        try {
            db.close();
        } catch (error) {
            this.logger.warn(`Closing ${this.dbPath} failed: ${String(error)}`);
        }
    }
}

function fileIdentity(path: string): { dev: number; ino: number } | null {
    try {
        const st = statSync(path);
        return { dev: st.dev, ino: st.ino };
    } catch {
        return null;
    }
}

/** SQLite errors that mean the handle itself is suspect, not the statement. */
function isHandleFault(error: unknown): boolean {
    const message = String((error as { message?: unknown })?.message ?? error);
    return /disk I\/O error|malformed|not a database|readonly database|unable to open|no such table/i.test(message);
}
