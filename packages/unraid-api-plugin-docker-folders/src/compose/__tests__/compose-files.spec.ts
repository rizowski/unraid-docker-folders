import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import {
    findComposeFile,
    getComposeFileContent,
    getEnvFileContent,
    getFileVersionContent,
    getFileVersions,
    parseComposeServiceNames,
    resolveComposeFilePath,
    resolveEnvFilePath,
    restoreFileVersion,
    saveComposeFileContent,
    saveEnvFileContent,
} from '../compose-files.js';

describe('resolveComposeFilePath / resolveEnvFilePath', () => {
    it('prefers an explicit absolute compose_file', () => {
        expect(
            resolveComposeFilePath({ working_dir: '/mnt/a', compose_file: '/mnt/b/docker-compose.yml' })
        ).toBe('/mnt/b/docker-compose.yml');
    });

    it('joins a relative compose_file onto working_dir', () => {
        expect(resolveComposeFilePath({ working_dir: '/mnt/a', compose_file: 'stack.yml' })).toBe(
            '/mnt/a/stack.yml'
        );
    });

    it('returns a relative compose_file unchanged when working_dir is empty', () => {
        // Matches PHP: `$path[0] !== '/' && !empty($stack['working_dir'])` is
        // false when working_dir is empty, so PHP falls through to
        // returning the relative path as-is (it then resolves against
        // PHP-FPM's own cwd, not this plugin's). Ported as the same
        // pass-through value; there is nothing meaningful to join it to here.
        expect(resolveComposeFilePath({ working_dir: null, compose_file: 'stack.yml' })).toBe('stack.yml');
    });

    it('falls back to a recognised filename in working_dir', () => {
        const dir = mkdtempSync(join(tmpdir(), 'compose-files-'));
        try {
            writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n');
            expect(resolveComposeFilePath({ working_dir: dir, compose_file: null })).toBe(
                join(dir, 'compose.yaml')
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('defaults to docker-compose.yml in working_dir even if nothing exists yet', () => {
        expect(resolveComposeFilePath({ working_dir: '/mnt/nothing-here', compose_file: null })).toBe(
            '/mnt/nothing-here/docker-compose.yml'
        );
    });

    it('returns null with neither compose_file nor working_dir', () => {
        expect(resolveComposeFilePath({ working_dir: null, compose_file: null })).toBeNull();
    });

    it('defaults env_file to .env in working_dir', () => {
        expect(resolveEnvFilePath({ working_dir: '/mnt/a', compose_file: null, env_file: null })).toBe(
            '/mnt/a/.env'
        );
    });
});

describe('findComposeFile', () => {
    it('returns the first recognised filename, in lookup order', () => {
        const dir = mkdtempSync(join(tmpdir(), 'compose-files-'));
        try {
            writeFileSync(join(dir, 'compose.yaml'), '');
            writeFileSync(join(dir, 'docker-compose.yaml'), '');
            // docker-compose.yml/.yaml both rank above compose.yml/.yaml.
            expect(findComposeFile(dir)).toBe(join(dir, 'docker-compose.yaml'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('returns null when no recognised filename exists', () => {
        const dir = mkdtempSync(join(tmpdir(), 'compose-files-'));
        try {
            expect(findComposeFile(dir)).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('parseComposeServiceNames', () => {
    it('reads top-level service keys only', () => {
        const content = [
            'services:',
            '  web:',
            '    image: nginx',
            '  worker:',
            '    image: redis',
            '    depends_on:',
            '      web:',
            'volumes:',
            '  data:',
        ].join('\n');
        expect(parseComposeServiceNames(content)).toEqual(['web', 'worker']);
    });

    it('returns [] with no services block', () => {
        expect(parseComposeServiceNames('volumes:\n  data:\n')).toEqual([]);
    });

    it('returns [] for empty content', () => {
        expect(parseComposeServiceNames('')).toEqual([]);
    });
});

describe('file read/write/versioning, against a real migrated database and tmp directory', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let stackDir: string;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        stackDir = mkdtempSync(join(tmpdir(), 'compose-stack-'));

        db.write((handle) => {
            handle
                .prepare(
                    `INSERT INTO compose_stacks
                        (project_name, working_dir, compose_file, env_file, autostart,
                         autostart_force_recreate, created_at, updated_at)
                     VALUES ('demo', ?, ?, NULL, 0, 0, 0, 0)`
                )
                .run(stackDir, join(stackDir, 'docker-compose.yml'));
        });
    });

    afterEach(() => {
        temp.cleanup();
        rmSync(stackDir, { recursive: true, force: true });
    });

    it('getComposeFileContent fails when the file does not exist yet', () => {
        const result = db.read((handle) => getComposeFileContent(handle, 'demo'));
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not found/);
    });

    it('getComposeFileContent fails when the stack is unknown', () => {
        const result = db.read((handle) => getComposeFileContent(handle, 'nope'));
        expect(result).toEqual({ success: false, error: 'Stack not found', content: null, path: null });
    });

    it('getEnvFileContent answers success with empty content when the file is absent (not an error)', () => {
        const result = db.read((handle) => getEnvFileContent(handle, 'demo'));
        expect(result.success).toBe(true);
        expect(result.content).toBe('');
    });

    it('saveComposeFileContent writes the file and can be read back', () => {
        const write = db.write((handle) => saveComposeFileContent(handle, 'demo', 'services: {}\n'));
        expect(write.success).toBe(true);

        const read = db.read((handle) => getComposeFileContent(handle, 'demo'));
        expect(read).toEqual({ success: true, error: null, content: 'services: {}\n', path: write.path });
    });

    it('saveComposeFileContent snapshots the previous version before overwriting', () => {
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v1\n'));
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v2\n'));

        const versions = db.read((handle) => getFileVersions(handle, 'demo', 'compose'));
        // Only the FIRST write (v1) is snapshotted: snapshotVersion captures
        // whatever was on disk BEFORE the new content lands, and there was
        // nothing on disk before the very first save.
        expect(versions.versions).toHaveLength(1);
        expect(versions.versions[0].file_type).toBe('compose');

        const detail = db.read((handle) =>
            getFileVersionContent(handle, 'demo', versions.versions[0].id)
        );
        expect(detail.success).toBe(true);
        expect(detail.version?.content).toBe('v1\n');
    });

    it('does not snapshot a save whose content is byte-identical to the latest snapshot', () => {
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v1\n'));
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v2\n'));
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v1\n')); // back to v1's bytes

        // The third save snapshots "v2" (what was on disk right before it),
        // but since that differs from the latest stored hash it is still
        // recorded — content_hash dedup only skips a snapshot identical to
        // the MOST RECENT one, not to any earlier one.
        const versions = db.read((handle) => getFileVersions(handle, 'demo', 'compose'));
        expect(versions.versions.map((v) => v.id)).toHaveLength(2);
    });

    it('restoreFileVersion writes the old content back and itself snapshots the current version', () => {
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v1\n'));
        db.write((handle) => saveComposeFileContent(handle, 'demo', 'v2\n'));

        const versions = db.read((handle) => getFileVersions(handle, 'demo', 'compose'));
        const v1Id = versions.versions[versions.versions.length - 1].id;

        const restore = db.write((handle) => restoreFileVersion(handle, 'demo', v1Id));
        expect(restore.success).toBe(true);

        const content = db.read((handle) => getComposeFileContent(handle, 'demo'));
        expect(content.content).toBe('v1\n');
    });

    it('saveEnvFileContent only snapshots when the existing env content is non-empty', () => {
        // No env file yet — the very first save must not attempt a snapshot
        // of nothing, matching `!== ''` in ComposeManager.php:1091.
        db.write((handle) => saveEnvFileContent(handle, 'demo', 'A=1\n'));
        const versions = db.read((handle) => getFileVersions(handle, 'demo', 'env'));
        expect(versions.versions).toHaveLength(0);

        db.write((handle) => saveEnvFileContent(handle, 'demo', 'A=2\n'));
        const versionsAfter = db.read((handle) => getFileVersions(handle, 'demo', 'env'));
        expect(versionsAfter.versions).toHaveLength(1);
    });

    it('getFileVersions rejects an unrecognised file type without touching the database', () => {
        const result = db.read((handle) => getFileVersions(handle, 'demo', 'nope'));
        expect(result).toEqual({ success: false, error: 'Invalid file type', versions: [] });
    });

    describe('containment on the version-history path (working_dir can be weak; label-derived)', () => {
        it('silently skips a snapshot when working_dir is empty', () => {
            db.write((handle) => {
                handle
                    .prepare(
                        `INSERT INTO compose_stacks
                            (project_name, working_dir, compose_file, env_file, autostart,
                             autostart_force_recreate, created_at, updated_at)
                         VALUES ('weak', '', ?, NULL, 0, 0, 0, 0)`
                    )
                    .run(join(stackDir, 'other.yml'));
            });

            // First save has no prior content to snapshot; the point under
            // test is the SECOND save, which would otherwise snapshot the
            // first save's content.
            db.write((handle) => saveComposeFileContent(handle, 'weak', 'v1\n'));
            const write = db.write((handle) => saveComposeFileContent(handle, 'weak', 'v2\n'));
            expect(write.success).toBe(true);

            const versions = db.read((handle) => getFileVersions(handle, 'weak', 'compose'));
            expect(versions.versions).toEqual([]);
        });

        it('silently skips a snapshot when working_dir is "/"', () => {
            // The live compose_file itself is a normal, writable path inside
            // the test's own tmp directory — only `working_dir` is the weak
            // "/" base, so this isolates the containment check in
            // `snapshotVersion` from any real filesystem permission error a
            // literal `/docker-compose.yml` write would otherwise conflate
            // it with.
            const rootComposeFile = join(stackDir, 'root.yml');
            db.write((handle) => {
                handle
                    .prepare(
                        `INSERT INTO compose_stacks
                            (project_name, working_dir, compose_file, env_file, autostart,
                             autostart_force_recreate, created_at, updated_at)
                         VALUES ('root', '/', ?, NULL, 0, 0, 0, 0)`
                    )
                    .run(rootComposeFile);
            });

            db.write((handle) => saveComposeFileContent(handle, 'root', 'v1\n')); // nothing to snapshot yet
            const write = db.write((handle) => saveComposeFileContent(handle, 'root', 'v2\n'));
            expect(write.success).toBe(true);

            const versions = db.read((handle) => getFileVersions(handle, 'root', 'compose'));
            expect(versions.versions).toEqual([]);
        });

        it('getFileVersionContent refuses a version row whose path escapes working_dir', () => {
            db.write((handle) => {
                handle
                    .prepare(
                        `INSERT INTO compose_file_versions
                            (project_name, file_type, file_path, content_hash, created_at)
                         VALUES ('demo', 'compose', '../../etc/passwd', 'deadbeef', 0)`
                    )
                    .run();
            });

            const rowId = db.read(
                (handle) =>
                    (handle.prepare('SELECT id FROM compose_file_versions WHERE project_name = ?').get('demo') as {
                        id: number;
                    }).id
            );

            const result = db.read((handle) => getFileVersionContent(handle, 'demo', rowId));
            expect(result).toEqual({
                success: false,
                error: 'Version file path is not valid',
                version: null,
            });
        });
    });
});
