import { existsSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { DatabaseService } from '../database.service.js';

describe('DatabaseService', () => {
    let temp: TempDatabase;
    let db: DatabaseService;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
    });

    afterEach(() => {
        temp.cleanup();
    });

    /**
     * Reads wait as long as writes do.
     *
     * Under WAL a reader does not block on a writer, so it is easy to think a
     * reader needs no timeout. It does: a checkpoint takes an exclusive lock,
     * SQLite checkpoints on its own once the WAL passes a thousand pages, and
     * a burst of PHP writes reaches that. A reader that does not wait answers
     * "database is locked" and the page shows no folders at all, which is what
     * tower did on the first load in GraphQL mode.
     */
    it('waits for a lock on the read path, not only the write path', () => {
        const onRead = db.read((handle) => handle.prepare('PRAGMA busy_timeout').get());
        const onWrite = db.write((handle) => handle.prepare('PRAGMA busy_timeout').get());

        expect(onRead).toEqual({ timeout: 5000 });
        expect(onWrite).toEqual({ timeout: 5000 });
    });

    it('matches the 5000ms Database.php asks for, so both backends wait alike', () => {
        expect(db.read((handle) => handle.prepare('PRAGMA busy_timeout').get())).toEqual({
            timeout: 5000,
        });
    });

    it('refuses a write through a read handle', () => {
        expect(() => db.read((handle) => handle.prepare('DELETE FROM folders').run())).toThrow();
    });
});

describe('DatabaseService shared handle', () => {
    let temp: TempDatabase;
    let db: DatabaseService;

    beforeEach(() => {
        vi.useFakeTimers();
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
    });

    afterEach(() => {
        db.onModuleDestroy();
        vi.useRealTimers();
        temp.cleanup();
    });

    it('keeps one handle across a burst of calls and closes it once idle', () => {
        const first = db.read((handle) => handle);
        const second = db.write((handle) => handle);
        expect(second).toBe(first);
        expect(db.isOpen).toBe(true);

        vi.advanceTimersByTime(1999);
        expect(db.isOpen).toBe(true);
        vi.advanceTimersByTime(1);
        expect(db.isOpen).toBe(false);

        // Idle close checkpoints the WAL into data.db, the way PHP leaves it.
        expect(existsSync(`${temp.path}-wal`)).toBe(false);
    });

    it('restarts the idle wait on each call', () => {
        db.query('SELECT 1');
        vi.advanceTimersByTime(1500);
        db.query('SELECT 1');
        vi.advanceTimersByTime(1500);
        expect(db.isOpen).toBe(true);
    });

    it('still refuses a write inside a read, including a nested read', () => {
        expect(() => db.read(() => db.read((handle) => handle.prepare('DELETE FROM folders').run()))).toThrow();
        expect(() => db.read((handle) => {
            db.read(() => undefined);
            return handle.prepare('DELETE FROM folders').run();
        })).toThrow();
        // The guard is lifted afterwards, so a write still works.
        expect(() => db.write((handle) => handle.prepare('DELETE FROM folders').run())).not.toThrow();
    });

    it('lets a write reached from inside a read commit, then restores the guard', () => {
        db.read(() => {
            db.write((handle) => handle.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('probe', '1', 0)").run());
        });
        expect(db.query("SELECT value FROM settings WHERE key = 'probe'")).toEqual([{ value: '1' }]);
        expect(() => db.read((handle) => handle.prepare('DELETE FROM settings').run())).toThrow();
    });

    it('rolls back a failed write and leaves no transaction open', () => {
        expect(() =>
            db.write((handle) => {
                handle.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('gone', '1', 0)").run();
                throw new Error('boom');
            })
        ).toThrow('boom');
        expect(db.query("SELECT value FROM settings WHERE key = 'gone'")).toEqual([]);
        expect(db.read((handle) => handle.isTransaction)).toBe(false);
    });

    it('reopens when data.db is replaced by another file', () => {
        db.write((handle) => handle.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('which', 'old', 0)").run());
        const other = createMigratedDatabase();
        try {
            const seed = new DatabaseSync(other.path);
            seed.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('which', 'new', 0)").run();
            seed.close();
            // A clean replacement: the old file's WAL and shm go with it. A
            // WAL left beside a replaced file is applied to the new file by
            // any connection, which is SQLite's own hazard and why nothing
            // should swap data.db while PHP or the plugin has it open.
            renameSync(other.path, temp.path);
            rmSync(`${temp.path}-wal`, { force: true });
            rmSync(`${temp.path}-shm`, { force: true });
            expect(db.query("SELECT value FROM settings WHERE key = 'which'")).toEqual([{ value: 'new' }]);
        } finally {
            other.cleanup();
        }
    });
});
