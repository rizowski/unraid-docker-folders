import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
