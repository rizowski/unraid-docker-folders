import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { FolderService } from '../../folders/folder.service.js';
import { DEFAULT_COMPOSE_PATHS } from '../compose-config.js';
import { removeComposeStack, type RemoveContainer } from '../compose-remove.js';
import { repairImportedStacks } from '../compose-repair.js';
import {
    dcflachsSanitize,
    isValidComposeName,
    nameFromFolder,
    nameFromLabels,
    plusSanitize,
} from '../compose-project-name.js';
import cases from './project-name-cases.json' with { type: 'json' };

describe('project name rules (the same table as PHP)', () => {
    it.each(cases.plus)('plus $raw', (c) => expect(plusSanitize(c.raw)).toBe(c.expect));
    it.each(cases.dcflachs)('dcflachs $raw', (c) => expect(dcflachsSanitize(c.raw)).toBe(c.expect));
    it.each(cases.valid)('valid $name', (c) => expect(isValidComposeName(c.name)).toBe(c.expect));
    it.each(cases.folder)('folder: $why', (c) => {
        const got = nameFromFolder({
            dirName: c.dir,
            displayName: c.display,
            pinned: c.pinned,
            plusInstalled: c.plus,
            legacyOrigin: c.legacy,
        });
        expect(got.name).toBe(c.expect);
        expect(got.error === null).toBe(c.expect !== null);
    });

    it('takes the label of containers running from the folder, and flags a clash', () => {
        const c = (project: string, dir: string) => ({
            labels: { 'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': dir },
        });
        expect(nameFromLabels([c('immich', '/p/Immich/'), c('x', '/q')], ['/p/Immich'])).toEqual({ name: 'immich', error: null });
        expect(nameFromLabels([c('x', '/q')], ['/p/Immich'])).toEqual({ name: null, error: null });
        expect(nameFromLabels([c('a', '/p/I'), c('b', '/p/I')], ['/p/I']).error).toContain('more than one');
        expect(nameFromLabels([c('Bad.Name', '/p/I')], ['/p/I']).error).not.toBeNull();
        expect(nameFromLabels([c('evil', '/p/O/../I/../O')], ['/p/I'])).toEqual({ name: null, error: null });
    });
});

function labelled(name: string, project: string): RemoveContainer {
    return { name: `/${name}`, labels: { 'com.docker.compose.project': project } };
}

describe('stack removal and the repair of earlier imports (issue #25)', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let folders: FolderService;
    let root: string;
    let stacksDir: string;
    let projects: string;
    let paths: typeof DEFAULT_COMPOSE_PATHS;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        root = mkdtempSync(join(tmpdir(), 'compose-remove-'));
        stacksDir = join(root, 'compose-stacks');
        projects = join(root, 'compose.manager', 'projects');
        mkdirSync(stacksDir);
        mkdirSync(projects, { recursive: true });
        paths = { ...DEFAULT_COMPOSE_PATHS, stacksDir, pluginProjectsDir: projects, pluginDir: join(root, 'plugin') };
        folders = new FolderService(db, { publish: vi.fn() } as unknown as EventBusService, paths);
    });

    afterEach(() => {
        temp.cleanup();
        rmSync(root, { recursive: true, force: true });
    });

    function addStack(name: string, workingDir: string | null, composeFile: string | null, createdAt = 100, imported: string | null = null, env: string | null = null): void {
        db.write((h) => {
            h.prepare(
                `INSERT INTO compose_stacks (project_name, working_dir, compose_file, env_file, autostart,
                    autostart_force_recreate, imported_from, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`
            ).run(name, workingDir, composeFile, env, imported, createdAt, createdAt);
        });
    }

    function addOwnStack(name: string, createdAt = 100): string {
        const dir = join(stacksDir, name);
        mkdirSync(dir);
        writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
        writeFileSync(join(dir, '.env'), 'A=1\n');
        addStack(name, dir, join(dir, 'docker-compose.yml'), createdAt);
        return dir;
    }

    const names = () => temp.rows('SELECT project_name FROM compose_stacks ORDER BY project_name').map((r) => r.project_name);

    const remove = (project: string, deleteFiles: boolean, containers: RemoveContainer[] = []) =>
        removeComposeStack(db, project, deleteFiles, containers, stacksDir);

    describe('removal', () => {
        it('is not_found for an unknown stack', () => {
            expect(remove('nope', false)).toMatchObject({ success: false, code: 'not_found' });
        });

        it('deletes the row, its versions, its schedules and its folder, and keeps the files', () => {
            const dir = addOwnStack('Immich');
            db.write((h) => {
                h.prepare(
                    `INSERT INTO compose_file_versions (project_name, file_type, file_path, content_hash, created_at)
                     VALUES ('Immich', 'compose', '.versions/1-compose.yml', 'h', 1)`
                ).run();
                for (const target of ['Immich', 'other']) {
                    h.prepare(
                        `INSERT INTO schedules (name, target_type, target_id, action, cron_expression, enabled, created_at, updated_at)
                         VALUES ('s', 'stack', ?, 'restart', '0 3 * * *', 1, 1, 1)`
                    ).run(target);
                }
                h.prepare(
                    `INSERT INTO folders (name, icon, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                     VALUES ('Immich', 'layer-group', 0, 0, 'Immich', 'manual', 1, 1)`
                ).run();
            });

            const result = remove('Immich', false);

            expect(result).toMatchObject({ success: true, schedulesRemoved: 1, folder: 'deleted', filesRemoved: [] });
            expect(names()).toEqual([]);
            expect(temp.rows('SELECT * FROM compose_file_versions')).toEqual([]);
            expect(temp.rows('SELECT target_id FROM schedules')).toEqual([{ target_id: 'other' }]);
            expect(temp.rows('SELECT * FROM folders')).toEqual([]);
            expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(true);
        });

        it("keeps a folder that holds another project's live container, as a plain folder", () => {
            addOwnStack('Immich');
            db.write((h) => {
                h.prepare(
                    `INSERT INTO folders (id, name, icon, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                     VALUES (7, 'Immich', 'layer-group', 0, 0, 'Immich', 'manual', 1, 1)`
                ).run();
                h.prepare(`INSERT INTO container_folders (container_id, container_name, folder_id, position) VALUES ('i', 'web', 7, 0)`).run();
            });

            const result = remove('Immich', false, [labelled('web', 'other')]);

            expect(result).toMatchObject({ success: true, folder: 'kept' });
            expect(temp.rows('SELECT compose_project FROM folders')).toEqual([{ compose_project: null }]);
            expect(temp.rows('SELECT container_name FROM container_folders')).toEqual([{ container_name: 'web' }]);
        });

        it('keeps a folder that holds a plain container with no compose label', () => {
            addOwnStack('Immich');
            db.write((h) => {
                h.prepare(
                    `INSERT INTO folders (id, name, icon, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                     VALUES (7, 'Immich', 'layer-group', 0, 0, 'Immich', 'manual', 1, 1)`
                ).run();
                h.prepare(`INSERT INTO container_folders (container_id, container_name, folder_id, position) VALUES ('i', 'plex', 7, 0)`).run();
            });

            const result = remove('Immich', false, [{ name: '/plex', labels: {} }]);

            expect(result).toMatchObject({ success: true, folder: 'kept' });
            expect(temp.rows('SELECT container_name FROM container_folders')).toEqual([{ container_name: 'plex' }]);
        });

        it('is refused while containers of the stack exist', () => {
            addOwnStack('Immich');

            const result = remove('Immich', true, [labelled('immich_server', 'Immich')]);

            expect(result).toMatchObject({ success: false, code: 'in_use' });
            expect(result.success === false && result.error).toContain('Stack Down');
            expect(names()).toEqual(['Immich']);
            expect(existsSync(join(stacksDir, 'Immich', 'docker-compose.yml'))).toBe(true);
        });

    });

    describe('file deletion', () => {
        it('removes the own copy, its version snapshots and its directory', () => {
            const dir = addOwnStack('Immich');
            mkdirSync(join(dir, '.versions'));
            writeFileSync(join(dir, '.versions', '1700000000-compose.yml'), 'old');

            const result = remove('Immich', true);

            expect(result).toMatchObject({ success: true, directoryRemoved: true });
            expect(existsSync(dir)).toBe(false);
        });

        it('leaves a directory that holds a file the plugin did not write', () => {
            const dir = addOwnStack('Immich');
            mkdirSync(join(dir, 'data'));
            writeFileSync(join(dir, 'data', 'library.db'), 'precious');

            const result = remove('Immich', true);

            expect(result).toMatchObject({ success: true, directoryRemoved: false });
            expect(existsSync(join(dir, 'data', 'library.db'))).toBe(true);
            expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(false);
        });

        it('never deletes a compose.manager directory', () => {
            const outside = join(root, 'compose.manager', 'projects', 'Immich');
            mkdirSync(outside, { recursive: true });
            writeFileSync(join(outside, 'docker-compose.yml'), 'services: {}');
            addStack('Immich', outside, join(outside, 'docker-compose.yml'));

            const result = remove('Immich', true);

            expect(result).toMatchObject({ success: true, filesRemoved: [] });
            expect(existsSync(join(outside, 'docker-compose.yml'))).toBe(true);
            expect(names()).toEqual([]);
        });

        it('never deletes the stacks directory itself', () => {
            writeFileSync(join(stacksDir, 'docker-compose.yml'), 'x');
            addStack('Odd', stacksDir, join(stacksDir, 'docker-compose.yml'));

            remove('Odd', true);

            expect(existsSync(join(stacksDir, 'docker-compose.yml'))).toBe(true);
        });

        it('does not follow ".." out of the stacks directory', () => {
            const victim = join(root, 'victim');
            mkdirSync(victim);
            writeFileSync(join(victim, 'docker-compose.yml'), 'keep');
            addStack('Sneaky', `${stacksDir}/../victim`, null);

            remove('Sneaky', true);

            expect(existsSync(join(victim, 'docker-compose.yml'))).toBe(true);
        });

        it('does not treat a sibling with the same prefix as inside', () => {
            const evil = join(root, 'compose-stacks-evil', 'x');
            mkdirSync(evil, { recursive: true });
            writeFileSync(join(evil, 'docker-compose.yml'), 'keep');
            addStack('Evil', evil, join(evil, 'docker-compose.yml'));

            remove('Evil', true);

            expect(existsSync(join(evil, 'docker-compose.yml'))).toBe(true);
        });

        it('does not follow a symlinked stack directory', () => {
            const target = join(root, 'appdata');
            mkdirSync(target);
            writeFileSync(join(target, 'docker-compose.yml'), 'keep');
            symlinkSync(target, join(stacksDir, 'Linked'));
            addStack('Linked', join(stacksDir, 'Linked'), join(stacksDir, 'Linked', 'docker-compose.yml'));

            remove('Linked', true);

            expect(readdirSync(target)).toEqual(['docker-compose.yml']);
        });

        it('keeps the files while a container runs from the own directory', () => {
            const dir = addOwnStack('Immich', 100);
            addStack('immich', '/elsewhere', null, 200);
            const container = {
                name: '/immich_server',
                labels: { 'com.docker.compose.project': 'immich', 'com.docker.compose.project.working_dir': dir },
            };

            const result = remove('Immich', true, [container]);

            expect(result).toMatchObject({ success: true, filesRemoved: [] });
            expect(result.success && result.filesNote).toContain('Containers still run');
            expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(true);
        });

        it('keeps the files when a relative config file resolves into the own directory', () => {
            const dir = addOwnStack('Immich', 100);
            addStack('immich', '/elsewhere', null, 200);
            const container = {
                name: '/immich_server',
                labels: {
                    'com.docker.compose.project': 'immich',
                    'com.docker.compose.project.working_dir': stacksDir,
                    'com.docker.compose.project.config_files': 'Immich/docker-compose.yml',
                },
            };

            expect(remove('Immich', true, [container])).toMatchObject({ filesRemoved: [] });
            expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(true);
        });

        it('deletes the files while containers run from another directory', () => {
            const dir = addOwnStack('Immich', 100);
            addStack('immich', '/elsewhere', null, 200);

            const result = remove('Immich', true, [labelled('immich_server', 'other')]);

            expect(result).toMatchObject({ success: true, directoryRemoved: true });
            expect(existsSync(dir)).toBe(false);
        });

        it('never unlinks a file name outside the allowlist', () => {
            const dir = join(stacksDir, 'Odd');
            mkdirSync(dir);
            writeFileSync(join(dir, 'app.db'), 'precious');
            writeFileSync(join(dir, 'secret.txt'), 'precious');
            writeFileSync(join(dir, 'prod.env'), 'A=1');
            addStack('Odd', dir, join(dir, 'app.db'));
            db.write((h) => h.prepare("UPDATE compose_stacks SET env_file = ? WHERE project_name = 'Odd'").run(join(dir, 'prod.env')));

            const result = remove('Odd', true);

            expect(result).toMatchObject({ success: true, directoryRemoved: false });
            expect(existsSync(join(dir, 'app.db'))).toBe(true);
            expect(existsSync(join(dir, 'secret.txt'))).toBe(true);
            expect(existsSync(join(dir, 'prod.env'))).toBe(false);
            expect(result.success && result.filesNote).not.toBeNull();
        });

        it('keeps a directory another stack still uses', () => {
            const dir = addOwnStack('Immich');
            addStack('immich', dir, join(dir, 'docker-compose.yml'), 200);

            remove('Immich', true);

            expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(true);
            expect(names()).toEqual(['immich']);
        });
    });
});

describe('repair of earlier imports', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let root: string;
    let stacksDir: string;
    let projects: string;
    let paths: typeof DEFAULT_COMPOSE_PATHS;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        root = mkdtempSync(join(tmpdir(), 'compose-repair-'));
        stacksDir = join(root, 'compose-stacks');
        projects = join(root, 'compose.manager', 'projects');
        mkdirSync(stacksDir);
        mkdirSync(projects, { recursive: true });
        paths = { ...DEFAULT_COMPOSE_PATHS, stacksDir, pluginProjectsDir: projects, pluginDir: join(root, 'plugin') };
    });

    afterEach(() => {
        temp.cleanup();
        rmSync(root, { recursive: true, force: true });
    });

    const repair = () => db.write((h) => repairImportedStacks(h, paths));
    const run = (sql: string, ...args: (string | number | null)[]) => db.write((h) => h.prepare(sql).run(...args));
    const names = () => temp.rows('SELECT project_name FROM compose_stacks ORDER BY project_name').map((r) => r.project_name);

    function source(dir: string, compose = 'services: {}\n', env?: string): string {
        const p = join(projects, dir);
        mkdirSync(p, { recursive: true });
        writeFileSync(join(p, 'docker-compose.yml'), compose);
        if (env !== undefined) writeFileSync(join(p, '.env'), env);
        return p;
    }

    /** The copy and rows an earlier import made. */
    function oldCopy(dir: string, compose = 'services: {}\n', env?: string): string {
        const p = join(stacksDir, dir);
        mkdirSync(p);
        writeFileSync(join(p, 'docker-compose.yml'), compose);
        if (env !== undefined) writeFileSync(join(p, '.env'), env);
        run(
            `INSERT INTO compose_stacks (project_name, working_dir, compose_file, env_file, autostart, autostart_force_recreate, description, imported_from, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, 0, 'Web', 'compose_plugin', 100, 100)`,
            dir,
            p,
            join(p, 'docker-compose.yml'),
            env === undefined ? null : join(p, '.env')
        );
        run("INSERT INTO folders (name, icon, position, collapsed, compose_project, sort_mode, created_at, updated_at) VALUES (?, 'layer-group', 0, 0, ?, 'manual', 1, 1)", dir, dir);
        return p;
    }

    function labelRow(name: string, dir: string): void {
        run(
            `INSERT INTO compose_stacks (project_name, working_dir, compose_file, env_file, autostart, autostart_force_recreate, imported_from, created_at, updated_at)
             VALUES (?, ?, ?, NULL, 0, 0, NULL, 300, 300)`,
            name,
            dir,
            join(dir, 'docker-compose.yml')
        );
    }

    it('merges the copy into the row the labels made, moving schedules, versions and the folder', () => {
        const src = source('Immich');
        const copy = oldCopy('Immich');
        labelRow('immich', src);
        run("INSERT INTO folders (name, icon, position, collapsed, compose_project, sort_mode, created_at, updated_at) VALUES ('immich', 'layer-group', 0, 0, 'immich', 'manual', 1, 1)");
        run("INSERT INTO schedules (name, target_type, target_id, action, cron_expression, enabled, created_at, updated_at) VALUES ('s', 'stack', 'Immich', 'restart', '0 3 * * *', 1, 1, 1)");
        mkdirSync(join(copy, '.versions'));
        writeFileSync(join(copy, '.versions', '5-compose.yml'), 'old\n');
        run("INSERT INTO compose_file_versions (project_name, file_type, file_path, content_hash, created_at) VALUES ('Immich', 'compose', '.versions/5-compose.yml', 'h', 5)");

        expect(repair()).toBe(true);

        expect(names()).toEqual(['immich']);
        const row = temp.rows("SELECT * FROM compose_stacks WHERE project_name = 'immich'")[0];
        expect(row.imported_from).toBe('compose_plugin');
        expect(row.description).toBe('Web');
        expect(row.autostart).toBe(1);
        expect(temp.rows('SELECT target_id FROM schedules')).toEqual([{ target_id: 'immich' }]);
        const version = temp.rows('SELECT project_name, file_path FROM compose_file_versions')[0];
        expect(version.project_name).toBe('immich');
        expect(readFileSync(join(src, String(version.file_path)), 'utf8')).toBe('old\n');
        expect(temp.rows('SELECT compose_project FROM folders')).toEqual([{ compose_project: 'immich' }]);
        // Nothing on disk was removed.
        expect(existsSync(join(copy, 'docker-compose.yml'))).toBe(true);
        expect(existsSync(join(copy, '.versions', '5-compose.yml'))).toBe(true);
    });

    it('detaches an imported folder that holds containers', () => {
        const src = source('Immich');
        oldCopy('Immich');
        labelRow('immich', src);
        run("INSERT INTO folders (name, icon, position, collapsed, compose_project, sort_mode, created_at, updated_at) VALUES ('immich', 'layer-group', 0, 0, 'immich', 'manual', 1, 1)");
        run("INSERT INTO container_folders (container_id, container_name, folder_id, position) VALUES ('x', 'photos-1', (SELECT id FROM folders WHERE name = 'Immich'), 0)");

        repair();

        expect(temp.rows("SELECT compose_project FROM folders WHERE name = 'Immich'")).toEqual([{ compose_project: null }]);
        expect(temp.rows('SELECT container_name FROM container_folders')).toEqual([{ container_name: 'photos-1' }]);
    });

    it('matches by the name rule when no row runs from the folder', () => {
        oldCopy('Nginx.Test');
        labelRow('nginx_test', join(root, 'appdata'));
        expect(repair()).toBe(true);
        expect(names()).toEqual(['nginx_test']);
    });

    it('renames a stopped stack when the copy matches the source byte for byte', () => {
        const src = source('Nginx.Test', 'services: {a: {}}\n', 'A=1\n');
        oldCopy('Nginx.Test', 'services: {a: {}}\n', 'A=1\n');
        run("INSERT INTO schedules (name, target_type, target_id, action, cron_expression, enabled, created_at, updated_at) VALUES ('s', 'stack', 'Nginx.Test', 'restart', '0 3 * * *', 1, 1, 1)");

        expect(repair()).toBe(true);

        expect(names()).toEqual(['nginx_test']);
        const row = temp.rows('SELECT * FROM compose_stacks')[0];
        expect(row.working_dir).toBe(src);
        expect(row.compose_file).toBe(join(src, 'docker-compose.yml'));
        expect(row.env_file).toBeNull();
        expect(row.autostart).toBe(1);
        expect(temp.rows('SELECT target_id FROM schedules')).toEqual([{ target_id: 'nginx_test' }]);
        expect(temp.rows('SELECT compose_project FROM folders')).toEqual([{ compose_project: 'nginx_test' }]);
    });

    it('repoints a row that already has a valid name', () => {
        const src = source('immich');
        oldCopy('immich');
        expect(repair()).toBe(true);
        expect(temp.rows('SELECT working_dir FROM compose_stacks')).toEqual([{ working_dir: src }]);
    });

    it('leaves two equally fitting counterparts alone', () => {
        const src = source('Immich');
        oldCopy('Immich');
        labelRow('immich', src);
        labelRow('immich_two', src);
        expect(repair()).toBe(false);
        expect(names()).toEqual(['Immich', 'immich', 'immich_two']);
    });

    it.each([
        ['the copy differs from the source', () => { source('Immich', 'services: {a: {}}\n'); oldCopy('Immich', 'services: {edited: {}}\n'); }],
        ['the source folder is gone', () => { oldCopy('Immich'); }],
        ['the copy env differs', () => { source('Immich', 'services: {}\n', 'A=1\n'); oldCopy('Immich', 'services: {}\n', 'A=2\n'); }],
        ['the name is one Compose refuses', () => { source('web@home'); oldCopy('web@home'); }],
    ])('leaves the row alone when %s', (_why, setup) => {
        setup();
        const before = JSON.stringify(temp.rows('SELECT * FROM compose_stacks'));
        expect(repair()).toBe(false);
        expect(JSON.stringify(temp.rows('SELECT * FROM compose_stacks'))).toBe(before);
    });

    it('is idempotent and writes nothing the second time', () => {
        const src = source('Immich');
        oldCopy('Immich');
        labelRow('immich', src);
        expect(repair()).toBe(true);
        const rows = JSON.stringify(temp.rows('SELECT * FROM compose_stacks'));
        const folders = JSON.stringify(temp.rows('SELECT * FROM folders'));
        expect(repair()).toBe(false);
        expect(JSON.stringify(temp.rows('SELECT * FROM compose_stacks'))).toBe(rows);
        expect(JSON.stringify(temp.rows('SELECT * FROM folders'))).toBe(folders);
    });

    it('does nothing without a copy row', () => {
        run("INSERT INTO compose_stacks (project_name, working_dir, autostart, autostart_force_recreate, imported_from, created_at, updated_at) VALUES ('a', ?, 0, 0, 'compose_plugin', 1, 1)", join(projects, 'a'));
        expect(repair()).toBe(false);
    });

    it('rolls back when a write fails and leaves the rest alone', () => {
        const src = source('Immich');
        oldCopy('Immich');
        labelRow('immich', src);
        run("CREATE TRIGGER boom BEFORE DELETE ON compose_stacks BEGIN SELECT RAISE(ABORT, 'boom'); END");
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(repair()).toBe(false);
        spy.mockRestore();
        expect(names()).toEqual(['Immich', 'immich']);
    });

    it('runs from the sync even with no compose container', () => {
        const src = source('Immich', 'services: {}\n');
        oldCopy('Immich');
        const folders = new FolderService(db, { publish: vi.fn() } as unknown as EventBusService, paths);
        expect(folders.syncWithContainers([])).toBe(true);
        expect(temp.rows('SELECT working_dir FROM compose_stacks')).toEqual([{ working_dir: src }]);
    });
});

