import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Build a real database out of the plugin's own migration files.
 *
 * The point is to test the write path against the schema that actually ships,
 * constraints and all, rather than a hand-written approximation that would
 * drift. `container_folders` has a UNIQUE on `container_name` and an ON DELETE
 * CASCADE, and both of those are load-bearing here.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = join(
    HERE,
    '../../../../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations'
);

export interface TempDatabase {
    path: string;
    /** Read rows straight out of the file, past the service being tested. */
    rows(sql: string, params?: unknown[]): Record<string, unknown>[];
    cleanup(): void;
}

export function createMigratedDatabase(): TempDatabase {
    const dir = mkdtempSync(join(tmpdir(), 'docker-folders-'));
    const path = join(dir, 'data.db');

    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
        if (!file.endsWith('.sql')) continue;
        db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    db.close();

    return {
        path,
        rows(sql: string, params: unknown[] = []) {
            const handle = new DatabaseSync(path, { readOnly: true });
            try {
                return handle.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
            } finally {
                handle.close();
            }
        },
        cleanup() {
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/**
 * Upsert, not insert: migration 009 already seeds a default `backup_destination`
 * row (and others), so a plain INSERT collides with it.
 */
export function seedSetting(dbPath: string, key: string, value: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Math.floor(Date.now() / 1000));
    db.close();
}
