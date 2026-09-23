import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
 * A handle is opened per call rather than held open. The file is small, PHP
 * writes to it concurrently, and a migration can replace it underneath us.
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

export type Row = Record<string, unknown>;

@Injectable()
export class DatabaseService {
    private readonly logger = new Logger(DatabaseService.name);

    constructor(
        @Optional() @Inject(DB_PATH_TOKEN) private readonly dbPath: string = DEFAULT_DB_PATH
    ) {}

    get path(): string {
        return this.dbPath;
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
     * Run `work` against one read-only handle.
     *
     * A reader that needs several statements takes one handle for all of them,
     * rather than one each. Opening a handle is a file open plus a WAL and shm
     * mapping, and the folder layout alone needs three statements.
     *
     * The busy timeout is set here as well as in `write`. See BUSY_TIMEOUT_MS:
     * a reader that meets a checkpoint and does not wait fails outright, and
     * the page then shows no folders at all.
     */
    read<T>(work: (db: DatabaseSync) => T): T {
        const db = new DatabaseSync(this.dbPath, { readOnly: true });
        try {
            db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
            return work(db);
        } finally {
            db.close();
        }
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
     */
    write<T>(work: (db: DatabaseSync) => T): T {
        const db = new DatabaseSync(this.dbPath);
        try {
            db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
            // Set explicitly, the way `Database.php` does. Deleting a folder
            // relies on the ON DELETE CASCADE in `container_folders`.
            db.exec('PRAGMA foreign_keys = ON');
            db.exec('BEGIN IMMEDIATE');
            try {
                const result = work(db);
                db.exec('COMMIT');
                return result;
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        } finally {
            db.close();
        }
    }
}
