import { BadRequestException } from '@nestjs/common';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import {
    type ArchiveOutcome,
    type BackupContainerHandle,
    type BackupDockerClient,
    type BackupListedContainer,
    type DockerMount,
    archivesFor,
    BackupService,
    createTarRunner,
    isArchiveName,
    isSqliteFile,
    mapContainerPath,
    quiesceModeFor,
    sidecarsFor,
    type TarRunner,
} from '../backup.service.js';

/**
 * Ported case for case from `tests/php/BackupSafetyTest.php`, plus coverage
 * for everything that test suite could not reach because it never
 * instantiates `BackupManager` (its constructor opens a database and a
 * Docker socket). `BackupService` takes both through constructor injection
 * instead, so the rest of this file exercises the parts PHP's suite leaves
 * to manual testing on a real box: quiesce/restore, pruning, deletion, and
 * the real `tar` invocation.
 */

const SQLITE_HEADER = `SQLite format 3\0${'\0'.repeat(84)}`;

function mounts(root: string): DockerMount[] {
    return [
        { Source: `${root}/appdata/plex`, Destination: '/config' },
        { Source: `${root}/media`, Destination: '/data' },
        // Nested inside /config on the container side, elsewhere on the host.
        // The longest match has to win.
        { Source: `${root}/cache/plex-db`, Destination: '/config/databases' },
    ];
}

describe('mapContainerPath', () => {
    function m(): DockerMount[] {
        return [
            { Source: '/mnt/user/appdata/plex', Destination: '/config' },
            { Source: '/mnt/user/media', Destination: '/data' },
            { Source: '/mnt/cache/plex-db', Destination: '/config/databases' },
        ];
    }

    it('maps a whole mount to its source', () => {
        const mapped = mapContainerPath('/config', m());
        expect(mapped?.hostPath).toBe('/mnt/user/appdata/plex');
        expect(mapped?.relative).toBe('');
    });

    it('treats a trailing slash as still the whole mount', () => {
        const mapped = mapContainerPath('/config/', m());
        expect(mapped?.hostPath).toBe('/mnt/user/appdata/plex');
        expect(mapped?.relative).toBe('');
    });

    it('picks the longest matching mount', () => {
        // Both /config and /config/databases cover this path. Picking
        // /config would archive the wrong disk entirely.
        const mapped = mapContainerPath('/config/databases/app.db', m());
        expect(mapped?.mountSource).toBe('/mnt/cache/plex-db');
        expect(mapped?.hostPath).toBe('/mnt/cache/plex-db/app.db');
    });

    it('rejects a path that climbs out of its mount', () => {
        expect(mapContainerPath('/config/../../etc/shadow', m())).toBeNull();
        expect(mapContainerPath('/config/x/../../..', m())).toBeNull();
    });

    it('rejects a path under no mount, including a name that merely starts the same', () => {
        expect(mapContainerPath('/etc/shadow', m())).toBeNull();
        expect(mapContainerPath('/config-evil/x', m())).toBeNull();
    });
});

describe('isSqliteFile / sidecarsFor', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'backup-safety-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeDatabase(name: string): string {
        const path = join(dir, name);
        writeFileSync(path, SQLITE_HEADER, 'latin1');
        return path;
    }

    it('recognizes a SQLite file by its header', () => {
        expect(isSqliteFile(writeDatabase('app.db'))).toBe(true);
    });

    it('recognizes anything else as not a database', () => {
        const text = join(dir, 'notes.txt');
        writeFileSync(text, 'SQLite is mentioned here but this is plain text');

        expect(isSqliteFile(text)).toBe(false);
        expect(isSqliteFile(join(dir, 'does-not-exist'))).toBe(false);
        expect(isSqliteFile(dir)).toBe(false); // a directory is not a file
    });

    it('finds sidecar files beside the database', () => {
        const db = writeDatabase('app.db');
        writeFileSync(`${db}-wal`, 'log');
        writeFileSync(`${db}-shm`, 'shared');

        // The actual corruption fix: a pattern like /config/*.db matches
        // app.db alone, and that copy is missing every committed transaction
        // still sitting in the write-ahead log.
        expect(sidecarsFor(db)).toEqual([`${db}-wal`, `${db}-shm`]);
    });

    it('finds nothing for a database with no sidecars', () => {
        expect(sidecarsFor(writeDatabase('clean.db'))).toEqual([]);
    });
});

/**
 * Ported case for case from `tests/php/BackupSafetyTest.php`'s
 * `archivesFor()`/`isArchiveName()` coverage (39c1091/badc832/b97b7e3,
 * reported to the dev branch), plus the two things that suite could not
 * reach: symlink exclusion and the `readdirSync` (not glob) directory read.
 */
describe('archivesFor / isArchiveName', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'backup-safety-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function touchArchive(name: string, mtimeSeconds: number): void {
        const path = join(dir, name);
        writeFileSync(path, 'x');
        utimesSync(path, new Date(mtimeSeconds * 1000), new Date(mtimeSeconds * 1000));
    }

    it('a container only owns its exact archives, not a same-named stack’s or a lookalike’s', () => {
        touchArchive('blog.2026-09-20_010000.tar.gz', 1000);
        touchArchive('blog.2026-09-21_010000.tar.gz', 2000);
        // A stack named "blog", and an unrelated container sharing the start
        // of the name. Retention/listing for "blog" must never touch these.
        touchArchive('blog.web.2026-09-22_010000.tar.gz', 3000);
        touchArchive('blogger.2026-09-22_010000.tar.gz', 3000);
        touchArchive('blog.tar.gz', 3000);

        const files = archivesFor(dir, 'blog').map((f) => basename(f));

        expect(files).toEqual(['blog.2026-09-21_010000.tar.gz', 'blog.2026-09-20_010000.tar.gz']);
    });

    it('a stack owns every service archive but not a container of the same name', () => {
        touchArchive('blog.db.2026-09-20_010000.tar.gz', 1000);
        touchArchive('blog.web.2026-09-21_010000.tar.gz', 2000);
        touchArchive('blog.2026-09-22_010000.tar.gz', 3000);

        const files = archivesFor(dir, 'blog', 'services').map((f) => basename(f));

        expect(files).toEqual(['blog.web.2026-09-21_010000.tar.gz', 'blog.db.2026-09-20_010000.tar.gz']);
    });

    it('a glob metacharacter in the destination matches nothing — readdir, not glob', () => {
        touchArchive('blog.2026-09-20_010000.tar.gz', 1000);

        // glob() would expand "*" and list the parent directory. readdirSync
        // on a literal (nonexistent) path does not.
        expect(archivesFor(`${dirname(dir)}/backup-safety-*`, 'blog')).toEqual([]);
    });

    it('excludes a symlink even when it is named and placed exactly like an archive', () => {
        const outside = mkdtempSync(join(tmpdir(), 'backup-safety-outside-'));
        try {
            const real = join(outside, 'old-secret.txt');
            writeFileSync(real, 'not an archive');
            const link = join(dir, 'blog.2026-09-20_010000.tar.gz');
            symlinkSync(real, link);
            touchArchive('blog.2026-09-21_010000.tar.gz', 2000);

            const files = archivesFor(dir, 'blog').map((f) => basename(f));

            expect(files).toEqual(['blog.2026-09-21_010000.tar.gz']);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it('returns nothing for a destination that does not exist', () => {
        expect(archivesFor(`${dir}/never-created`, 'blog')).toEqual([]);
    });

    it('isArchiveName only accepts the exact shape generateArchiveName writes', () => {
        expect(isArchiveName('plex.2026-09-22_031500.tar.gz')).toBe(true);
        expect(isArchiveName('blog.web.2026-09-22_031500.tar.gz')).toBe(true);

        expect(isArchiveName('appdata.tar.gz')).toBe(false);
        expect(isArchiveName('plex.2026-09-22_031500.tar')).toBe(false);
        expect(isArchiveName('movie.mkv')).toBe(false);
        expect(isArchiveName('.plex.2026-09-22_031500.tar.gz')).toBe(false);
        expect(isArchiveName('../plex.2026-09-22_031500.tar.gz')).toBe(false);
    });
});

describe('quiesceModeFor', () => {
    it('passes known modes through', () => {
        expect(quiesceModeFor('pause')).toBe('pause');
        expect(quiesceModeFor('stop')).toBe('stop');
        expect(quiesceModeFor('none')).toBe('none');
        expect(quiesceModeFor(' STOP ')).toBe('stop');
    });

    it('leaves the container alone on an unknown mode, failing closed rather than throwing', () => {
        expect(quiesceModeFor('kill')).toBe('none');
        expect(quiesceModeFor(null)).toBe('none');
        expect(quiesceModeFor(['pause'])).toBe('none');
        expect(quiesceModeFor('')).toBe('none');
        expect(quiesceModeFor(undefined)).toBe('none');
    });
});

describe('createTarRunner', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'tar-runner-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('archives a real file with a real tar process', async () => {
        const source = join(dir, 'file.txt');
        writeFileSync(source, 'hello');
        const archive = join(dir, 'out.tar.gz');

        const result = await createTarRunner().createArchive(archive, [source]);

        expect(result.success).toBe(true);
        expect(existsSync(archive)).toBe(true);
        expect(statSync(archive).size).toBeGreaterThan(0);
    });

    it('reports failure without throwing when a source path does not exist', async () => {
        const archive = join(dir, 'out.tar.gz');

        const result = await createTarRunner().createArchive(archive, [join(dir, 'missing-file')]);

        expect(result.success).toBe(false);
        expect(result.output).not.toBe('');
    });

    // The load-bearing proof for the "no shell strings" requirement. If this
    // ran through a shell string, a semicolon in a path argument would be
    // interpreted as a command separator. spawn() with an argv array passes
    // it to tar as one literal, nonexistent path instead, so tar fails on a
    // missing file and the shell command after the ";" never runs.
    it('never interprets a path as a shell command, even one shaped like an injection attempt', async () => {
        const marker = join(dir, 'pwned');
        const archive = join(dir, 'out.tar.gz');
        const hostileHostPath = join(dir, `nope; touch ${marker} #`);

        const result = await createTarRunner().createArchive(archive, [hostileHostPath]);

        expect(result.success).toBe(false);
        expect(existsSync(marker)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// BackupService
// ---------------------------------------------------------------------------

interface FakeContainer {
    names: string[];
    labels?: Record<string, string>;
    mounts?: DockerMount[];
    running?: boolean;
    paused?: boolean;
    failOn?: Partial<Record<'start' | 'stop' | 'pause' | 'unpause' | 'inspect', Error>>;
    /** Internal: how many times inspect() has been called on this container. */
    inspectCalls?: number;
}

function fakeDocker(containers: Record<string, FakeContainer>) {
    const calls: string[] = [];

    const listed: BackupListedContainer[] = Object.entries(containers).map(([id, c]) => ({
        Id: id,
        Names: c.names,
        Labels: c.labels ?? null,
    }));

    const client: BackupDockerClient = {
        listContainers: async () => listed,
        getContainer: (id: string): BackupContainerHandle => {
            const c = containers[id];
            return {
                inspect: async () => {
                    calls.push(`${id}:inspect`);
                    c.inspectCalls = (c.inspectCalls ?? 0) + 1;
                    // failOn.inspect only breaks the SECOND and later inspect
                    // calls. The first is always resolveHostPathsForContainer's
                    // mount lookup; a test that wants "the run-state read
                    // fails" needs the mount lookup to have already succeeded,
                    // the same way a real container answers mounts fine but a
                    // later state check can still race a socket hiccup.
                    if (c.failOn?.inspect && c.inspectCalls > 1) throw c.failOn.inspect;
                    return {
                        Mounts: c.mounts ?? [],
                        State: { Running: c.running ?? false, Paused: c.paused ?? false },
                    };
                },
                start: async () => {
                    calls.push(`${id}:start`);
                    if (c.failOn?.start) throw c.failOn.start;
                    c.running = true;
                    c.paused = false;
                },
                stop: async (options: { t: number }) => {
                    calls.push(`${id}:stop t=${options.t}`);
                    if (c.failOn?.stop) throw c.failOn.stop;
                    c.running = false;
                },
                pause: async () => {
                    calls.push(`${id}:pause`);
                    if (c.failOn?.pause) throw c.failOn.pause;
                    c.paused = true;
                },
                unpause: async () => {
                    calls.push(`${id}:unpause`);
                    if (c.failOn?.unpause) throw c.failOn.unpause;
                    c.paused = false;
                },
            };
        },
    };

    return { client, calls, containers };
}

function fakeTar(opts: { writeFile?: boolean; fail?: boolean; output?: string } = {}) {
    const { writeFile = true, fail = false, output = '' } = opts;
    const calls: { archivePath: string; hostPaths: string[] }[] = [];

    const tar: TarRunner = {
        async createArchive(archivePath, hostPaths): Promise<ArchiveOutcome> {
            calls.push({ archivePath, hostPaths });
            if (writeFile && !fail) {
                mkdirSync(dirname(archivePath), { recursive: true });
                writeFileSync(archivePath, 'fake-tar-contents');
            }
            return { success: !fail, output };
        },
    };

    return { tar, calls };
}

/** A 304-shaped error, the way dockerode raises "already in that state". */
function notModified(): Error {
    return Object.assign(new Error('not modified'), { statusCode: 304 });
}

/**
 * Upsert, not insert: migration 009 already seeds a default `backup_destination`
 * row (and others), so a plain INSERT collides with it.
 */
function seedSetting(dbPath: string, key: string, value: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Math.floor(Date.now() / 1000));
    db.close();
}

describe('BackupService', () => {
    let temp: TempDatabase;
    let root: string;

    beforeEach(() => {
        temp = createMigratedDatabase();
        root = mkdtempSync(join(tmpdir(), 'docker-folders-backup-'));
    });

    afterEach(() => {
        temp.cleanup();
        rmSync(root, { recursive: true, force: true });
    });

    function build(
        containers: Record<string, FakeContainer>,
        tarOpts: Parameters<typeof fakeTar>[0] = {}
    ) {
        const docker = fakeDocker(containers);
        const tar = fakeTar(tarOpts);
        const service = new BackupService(new DatabaseService(temp.path), docker.client, tar.tar, [root]);
        return { service, docker, tar };
    }

    describe('backupContainer', () => {
        it('archives the whole mount when the pattern names it exactly', async () => {
            const { service, tar } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            const result = await service.backupContainer('plex', ['/config'], `${root}/dest`);

            expect(result.success).toBe(true);
            expect(result.message).toContain('Backup created:');
            expect(result.backupFile).toMatch(/^.*\/plex\.\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/);
            expect(result.backupSize).toBeGreaterThan(0);
            expect(tar.calls[0].hostPaths).toEqual([`${root}/appdata/plex`]);
        });

        it('reports failure when the container does not exist', async () => {
            const { service } = build({});

            const result = await service.backupContainer('missing', ['/config'], `${root}/dest`);

            expect(result).toEqual({
                success: false,
                message: "Container 'missing' not found",
            });
        });

        it('reports failure when no pattern matches a mount', async () => {
            const { service } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            const result = await service.backupContainer('plex', ['/nope'], `${root}/dest`);

            expect(result.success).toBe(false);
            expect(result.message).toBe("No matching paths found for container 'plex'");
        });

        it('reports failure when the destination cannot be created', async () => {
            // A file where the destination should be a directory: mkdir fails.
            writeFileSync(`${root}/not-a-dir`, 'x');
            const { service } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            const result = await service.backupContainer('plex', ['/config'], `${root}/not-a-dir`);

            expect(result.success).toBe(false);
            expect(result.message).toBe(`Cannot create backup directory: ${root}/not-a-dir`);
        });

        it('throws when the destination resolves outside the allowed roots', async () => {
            const { service } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            await expect(
                service.backupContainer('plex', ['/config'], '/etc/evil')
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('includes sidecar files for a matched SQLite database', async () => {
            const dataDir = join(root, 'appdata', 'plex');
            mkdirSync(dataDir, { recursive: true });
            writeFileSync(join(dataDir, 'app.db'), SQLITE_HEADER, 'latin1');
            writeFileSync(join(dataDir, 'app.db-wal'), 'log');

            const { service, tar } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            await service.backupContainer('plex', ['/config/app.db'], `${root}/dest`);

            expect(tar.calls[0].hostPaths).toEqual([
                join(dataDir, 'app.db'),
                join(dataDir, 'app.db-wal'),
            ]);
        });

        it('resolves a glob pattern against real files under the mount', async () => {
            const dataDir = join(root, 'appdata', 'plex');
            mkdirSync(dataDir, { recursive: true });
            writeFileSync(join(dataDir, 'app.db'), 'x');
            writeFileSync(join(dataDir, 'other.txt'), 'x');

            const { service, tar } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            await service.backupContainer('plex', ['/config/*.db'], `${root}/dest`);

            expect(tar.calls[0].hostPaths).toEqual([join(dataDir, 'app.db')]);
        });

        describe('quiesce', () => {
            it('pauses a running container and resumes it after a successful backup', async () => {
                const { service, docker } = build({
                    c1: { names: ['/plex'], mounts: mounts(root), running: true },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'pause'
                );

                expect(result.success).toBe(true);
                expect(result.message).toContain('(container paused during backup)');
                expect(docker.calls).toEqual(['c1:inspect', 'c1:inspect', 'c1:pause', 'c1:unpause']);
            });

            it('stops a running container with a 30 second timeout and restarts it', async () => {
                const { service, docker } = build({
                    c1: { names: ['/plex'], mounts: mounts(root), running: true },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.success).toBe(true);
                expect(result.message).toContain('(container stopped during backup)');
                expect(docker.calls).toContain('c1:stop t=30');
                // Restore inspects first (mirrors DockerClient::startContainer)
                // then starts, since the container was stopped, not paused.
                expect(docker.calls.at(-1)).toBe('c1:start');
            });

            it('restarts the container even when tar fails (try/finally, not best-effort)', async () => {
                const { service, docker } = build(
                    { c1: { names: ['/plex'], mounts: mounts(root), running: true } },
                    { fail: true, output: 'tar: short write' }
                );

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.success).toBe(false);
                expect(result.message).toContain('Failed to create archive');
                expect(result.message).toContain('tar: short write');
                // inspect (mount lookup), inspect (run-state check), stop,
                // inspect (restore's paused check), start.
                expect(docker.calls).toEqual([
                    'c1:inspect',
                    'c1:inspect',
                    'c1:stop t=30',
                    'c1:inspect',
                    'c1:start',
                ]);
                expect(docker.containers.c1.running).toBe(true);
            });

            it('does not touch an already-stopped container', async () => {
                const { service, docker } = build({
                    c1: { names: ['/plex'], mounts: mounts(root), running: false, paused: false },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.success).toBe(true);
                expect(result.message).not.toContain('stopped during backup');
                expect(docker.calls).toEqual(['c1:inspect', 'c1:inspect']);
            });

            it('does not touch an already-paused container in pause mode', async () => {
                const { service, docker } = build({
                    c1: { names: ['/plex'], mounts: mounts(root), running: true, paused: true },
                });

                await service.backupContainer('plex', ['/config'], `${root}/dest`, null, 'pause');

                expect(docker.calls).toEqual(['c1:inspect', 'c1:inspect']);
            });

            it('fails closed instead of backing up unquietly when the state cannot be read', async () => {
                const { service, docker, tar } = build({
                    c1: {
                        names: ['/plex'],
                        mounts: mounts(root),
                        running: true,
                        failOn: { inspect: new Error('socket error') },
                    },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result).toEqual({
                    success: false,
                    message: 'Could not read the container state before the backup',
                });
                expect(tar.calls).toEqual([]);
                void docker;
            });

            it('fails closed instead of backing up unquietly when the container cannot be stopped', async () => {
                const { service, tar } = build({
                    c1: {
                        names: ['/plex'],
                        mounts: mounts(root),
                        running: true,
                        failOn: { stop: new Error('permission denied') },
                    },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.message).toBe('Could not stop the container before the backup');
                expect(tar.calls).toEqual([]);
            });

            it('treats a 304 from Docker as success, not failure, for stop and start', async () => {
                const { service, docker } = build({
                    c1: {
                        names: ['/plex'],
                        mounts: mounts(root),
                        running: true,
                        failOn: { stop: notModified(), start: notModified() },
                    },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.success).toBe(true);
                expect(result.message).toContain('(container stopped during backup)');
                expect(docker.calls).toContain('c1:stop t=30');
            });

            it('reports the backup as failed when the container cannot be restarted, even though the archive is on disk', async () => {
                const { service } = build({
                    c1: {
                        names: ['/plex'],
                        mounts: mounts(root),
                        running: true,
                        failOn: { start: new Error('start failed') },
                    },
                });

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.success).toBe(false);
                expect(result.message).toContain('The container could not be started again after the backup');
                expect(result.backupFile).toBeDefined();
                expect(existsSync(result.backupFile ?? '')).toBe(true);
            });

            // Ported bug: BackupManager.php's runArchiveJob() hardcodes
            // 'restore_error' => '' on the archive-failure branch, discarding
            // whatever withQuiesce() actually returned. If the container also
            // fails to restart, that fact never reaches the caller.
            // Fixed over the PHP, which reported only the archive failure and
            // said nothing about the container being left stopped.
            it('reports a failed restart even when the archive also failed', async () => {
                const { service, docker } = build(
                    {
                        c1: {
                            names: ['/plex'],
                            mounts: mounts(root),
                            running: true,
                            failOn: { start: new Error('start failed') },
                        },
                    },
                    { fail: true, output: 'disk full' }
                );

                const result = await service.backupContainer(
                    'plex',
                    ['/config'],
                    `${root}/dest`,
                    null,
                    'stop'
                );

                expect(result.success).toBe(false);
                expect(result.message).toContain('Failed to create archive');
                expect(result.message).toContain('The container could not be started again after the backup');
                expect(docker.containers.c1.running).toBe(false);
            });
        });
    });

    describe('backupStack', () => {
        function stackContainers(): Record<string, FakeContainer> {
            return {
                web: {
                    names: ['/blog_web_1'],
                    labels: { 'com.docker.compose.project': 'blog', 'com.docker.compose.service': 'web' },
                    mounts: [{ Source: `${root}/web-data`, Destination: '/data' }],
                    running: true,
                },
                db: {
                    names: ['/blog_db_1'],
                    labels: { 'com.docker.compose.project': 'blog', 'com.docker.compose.service': 'db' },
                    mounts: [{ Source: `${root}/db-data`, Destination: '/data' }],
                    running: true,
                },
            };
        }

        it('backs up each configured service independently', async () => {
            const { service, tar } = build(stackContainers());

            const result = await service.backupStack(
                'blog',
                [
                    { service: 'web', patterns: ['/data'] },
                    { service: 'db', patterns: ['/data'] },
                ],
                `${root}/dest`
            );

            expect(result.success).toBe(true);
            expect(result.message).toContain("Backed up service 'web'");
            expect(result.message).toContain("Backed up service 'db'");
            expect(tar.calls).toHaveLength(2);
        });

        it('reports failure for a stack with no matching containers', async () => {
            const { service } = build({});

            const result = await service.backupStack('nope', [{ service: 'web', patterns: ['/data'] }], `${root}/dest`);

            expect(result).toEqual({ success: false, message: "No containers found for stack 'nope'" });
        });

        it('reports, but does not abort on, a service missing from the stack', async () => {
            const { service } = build(stackContainers());

            const result = await service.backupStack(
                'blog',
                [{ service: 'cache', patterns: ['/data'] }],
                `${root}/dest`
            );

            expect(result.success).toBe(false);
            expect(result.message).toBe("Service 'cache' not found in stack");
        });

        // Ported from 35cebcb (reported to the dev branch): backupStack now
        // remembers the path of the last archive it wrote THIS run, instead of
        // scanning the destination for the newest file by mtime afterward. A
        // stale pre-existing archive for another service, even with a mtime
        // far in the future, must not be picked over what this run wrote.
        it('reports the archive it actually wrote last, not the newest by mtime in the directory', async () => {
            const { service } = build(stackContainers());
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            const stale = `${dest}/blog.db.2099-01-01_000000.tar.gz`;
            writeFileSync(stale, 'stale');
            utimesSync(stale, new Date(9999999999000), new Date(9999999999000));

            const result = await service.backupStack(
                'blog',
                [
                    { service: 'db', patterns: ['/data'] },
                    { service: 'web', patterns: ['/data'] },
                ],
                dest
            );

            expect(result.backupFile).toContain('blog.web.');
            expect(result.backupFile).not.toBe(stale);
        });

        // Ported from 35cebcb: a run that wrote nothing must report no
        // archive, not a leftover file the stack-scope pattern happens to
        // match (e.g. a service, or a differently-versioned stack, such as
        // "blog.v2" for "blog").
        it('reports no archive and size 0 when the run writes nothing', async () => {
            const { service } = build(stackContainers());

            const result = await service.backupStack(
                'blog',
                [{ service: 'cache', patterns: ['/data'] }],
                `${root}/dest`
            );

            expect(result.backupFile).toBe('');
            expect(result.backupSize).toBe(0);
        });

        // BackupManager.php:146-154: a config entry with no service name or
        // no paths is now a reported failure, not a silent skip — a run that
        // also successfully backs up another service must still fail
        // overall. (A run where nothing archives already fails on its own,
        // via the archived === 0 rule below, so this includes a valid 'db'
        // entry to isolate the branch under test from that one.)
        it('reports and fails a service entry with no service name or no paths', async () => {
            const { service, tar } = build(stackContainers());

            const result = await service.backupStack(
                'blog',
                [
                    { service: '', patterns: ['/data'] },
                    { service: 'web', patterns: [] },
                    { service: 'db', patterns: ['/data'] },
                ],
                `${root}/dest`
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('Skipped a service entry with no service name or no paths');
            expect(
                result.message.split('; ').filter((m) => m === 'Skipped a service entry with no service name or no paths')
            ).toHaveLength(2);
            expect(result.message).toContain("Backed up service 'db'");
            expect(tar.calls).toHaveLength(1);
        });

        // BackupManager.php:165-169: "no matching paths" must also fail the
        // run, the same as every other per-service failure branch — it was
        // reported but did not flip `allSuccess`. Includes a valid 'db' entry
        // so this fails on the branch under test, not just on archived === 0.
        it('fails the run, not just the message, when a service has no matching paths', async () => {
            const { service } = build(stackContainers());

            const result = await service.backupStack(
                'blog',
                [
                    { service: 'web', patterns: ['/no-such-mount'] },
                    { service: 'db', patterns: ['/data'] },
                ],
                `${root}/dest`
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain("No matching paths for service 'web'");
            expect(result.message).toContain("Backed up service 'db'");
        });

        // BackupManager.php:179-188: the failure branch pushes
        // `restore_error` too, not only the success branch — a service that
        // fails to archive AND fails to restart must report both.
        it('reports a failed restart even when the service also failed to archive', async () => {
            const { service } = build(
                {
                    web: {
                        names: ['/blog_web_1'],
                        labels: { 'com.docker.compose.project': 'blog', 'com.docker.compose.service': 'web' },
                        mounts: [{ Source: `${root}/web-data`, Destination: '/data' }],
                        running: true,
                        failOn: { start: new Error('start failed') },
                    },
                },
                { fail: true, output: 'disk full' }
            );

            const result = await service.backupStack(
                'blog',
                [{ service: 'web', patterns: ['/data'] }],
                `${root}/dest`,
                null,
                'stop'
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain("Failed to create archive for service 'web'");
            expect(result.message).toContain(
                "Service 'web': The container could not be started again after the backup"
            );
        });

        // BackupManager.php:201-206: zero archives written forces failure and,
        // when nothing else already explains why (an empty `serviceConfigs`),
        // adds its own message.
        it('forces failure and reports no services configured for an empty config', async () => {
            const { service } = build(stackContainers());

            const result = await service.backupStack('blog', [], `${root}/dest`);

            expect(result).toEqual({
                success: false,
                message: "No services configured for stack 'blog'",
                backupFile: '',
                backupSize: 0,
            });
        });

    });

    describe('listBackups', () => {
        it('lists a container’s archives newest first', () => {
            const { service } = build({});
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            writeFileSync(`${dest}/plex.2020-01-01_000000.tar.gz`, 'a');
            writeFileSync(`${dest}/plex.2021-01-01_000000.tar.gz`, 'b');
            utimesSync(`${dest}/plex.2020-01-01_000000.tar.gz`, new Date(1000), new Date(1000));
            utimesSync(`${dest}/plex.2021-01-01_000000.tar.gz`, new Date(2000), new Date(2000));

            seedSetting(temp.path, 'backup_destination', dest);
            // BackupService reads its default destination from the DB; force a
            // fresh read by rebuilding against the same temp db.
            const rebuilt = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            const listed = rebuilt.listBackups('container', 'plex');

            expect(listed.map((b) => b.filename)).toEqual([
                'plex.2021-01-01_000000.tar.gz',
                'plex.2020-01-01_000000.tar.gz',
            ]);
            void service;
        });

        // The PHP ignored targetType, so a container's list included a
        // same-named stack's service archives and the other way round.
        it('keeps a container’s archives and a same-named stack’s apart', () => {
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            writeFileSync(`${dest}/blog.2020-01-01_000000.tar.gz`, 'container');
            writeFileSync(`${dest}/blog.web.2020-01-01_000000.tar.gz`, 'stack');
            seedSetting(temp.path, 'backup_destination', dest);
            const rebuilt = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(rebuilt.listBackups('container', 'blog').map((b) => b.filename)).toEqual([
                'blog.2020-01-01_000000.tar.gz',
            ]);
            expect(rebuilt.listBackups('stack', 'blog').map((b) => b.filename)).toEqual([
                'blog.web.2020-01-01_000000.tar.gz',
            ]);
        });

        it('returns nothing for a destination that does not exist yet', () => {
            seedSetting(temp.path, 'backup_destination', `${root}/never-created`);
            const { service } = build({});
            expect(service.listBackups('container', 'plex')).toEqual([]);
        });

        // Fixed over the PHP, which never rechecked containment here: a
        // destination containing a glob metacharacter turned the directory
        // part of the pattern into a wildcard over its siblings.
        it('does not list a sibling directory’s archive when the destination contains a glob metacharacter', () => {
            const dest = `${root}/back*ups`; // literal directory name, contains "*"
            const sibling = `${root}/backXups`; // matches the glob "back*ups"
            mkdirSync(dest, { recursive: true });
            mkdirSync(sibling, { recursive: true });
            writeFileSync(`${sibling}/plex.2020-01-01_000000.tar.gz`, 'a');

            seedSetting(temp.path, 'backup_destination', dest);
            const rebuilt = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            const files = rebuilt.listBackups('container', 'plex');

            expect(files.map((f) => f.path)).not.toContain(`${sibling}/plex.2020-01-01_000000.tar.gz`);
        });
    });

    describe('pruning (via repeated backupContainer calls)', () => {
        it('keeps only the newest `retention` archives for a prefix', async () => {
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            // listBackups() (used below to check what remains) has no
            // destination parameter of its own -- it always resolves the
            // configured default, same as PHP.
            seedSetting(temp.path, 'backup_destination', dest);
            // Two pre-existing "old" archives for this container.
            writeFileSync(`${dest}/plex.2019-01-01_000000.tar.gz`, 'old1');
            writeFileSync(`${dest}/plex.2019-02-01_000000.tar.gz`, 'old2');
            utimesSync(`${dest}/plex.2019-01-01_000000.tar.gz`, new Date(1000), new Date(1000));
            utimesSync(`${dest}/plex.2019-02-01_000000.tar.gz`, new Date(2000), new Date(2000));

            const { service } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            const result = await service.backupContainer('plex', ['/config'], dest, 1);

            expect(result.success).toBe(true);
            expect(result.message).toContain('pruned 2 old backup(s)');
            const remaining = service.listBackups('container', 'plex');
            expect(remaining).toHaveLength(1);
            expect(remaining[0].filename).toBe(result.backupFile ? basename(result.backupFile) : '');
        });

        // The load-bearing case: a destination containing a glob metacharacter
        // must not let pruning delete a sibling directory's archives, even
        // though the naive glob pattern would match them. This is what the
        // per-file pathIsWithin recheck inside pruneOldBackups actually
        // defends against (not symlinks -- pathIsWithin is lexical only).
        it('never deletes a sibling directory that merely matches the destination glob', async () => {
            const dest = `${root}/back*ups`;
            const sibling = `${root}/backXups`;
            mkdirSync(dest, { recursive: true });
            mkdirSync(sibling, { recursive: true });
            const siblingFile = `${sibling}/plex.2019-01-01_000000.tar.gz`;
            writeFileSync(siblingFile, 'sibling-archive');
            utimesSync(siblingFile, new Date(1000), new Date(1000));

            // Two archives inside the *real* destination, so retention=1 forces
            // a prune pass.
            const destFile1 = `${dest}/plex.2019-01-01_000000.tar.gz`;
            const destFile2 = `${dest}/plex.2019-02-01_000000.tar.gz`;
            writeFileSync(destFile1, 'a');
            writeFileSync(destFile2, 'b');
            utimesSync(destFile1, new Date(1000), new Date(1000));
            utimesSync(destFile2, new Date(2000), new Date(2000));

            const { service } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            await service.backupContainer('plex', ['/config'], dest, 1);

            expect(existsSync(siblingFile)).toBe(true);
        });

        // Ported bug: sanitizeArchivePrefix has no way to keep one prefix from
        // being a filename-prefix of another's ("blog" vs "blog.web"), so
        // pruning a container named the same as a stack project can delete
        // that stack's own service archives.
        // Fixed over the PHP, where "blog.*.tar.gz" also matched a stack
        // service's "blog.web.<stamp>.tar.gz", so one target's retention
        // deleted another target's backups.
        it('leaves a same-named stack’s service archives alone when pruning a container', async () => {
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            const stackArchive = `${dest}/blog.web.2019-01-01_000000.tar.gz`;
            writeFileSync(stackArchive, 'stack-archive');
            utimesSync(stackArchive, new Date(1000), new Date(1000));

            const { service } = build({
                c1: { names: ['/blog'], mounts: mounts(root), running: true },
            });

            // Container literally named "blog" backing up with retention 0
            // (clamped to 1) forces a prune of everything matching "blog.*".
            await service.backupContainer('blog', ['/config'], dest, 1);
            await service.backupContainer('blog', ['/config'], dest, 1);

            expect(existsSync(stackArchive)).toBe(true);
        });
    });

    describe('deleteBackup', () => {
        // Fixed over the PHP, which deleted any regular file under the
        // destination; with a destination of an allowed root such as /mnt
        // that was any file under /mnt.
        it('refuses a file that is not one of this service’s archives', () => {
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            const precious = `${dest}/notes.txt`;
            writeFileSync(precious, 'keep me');
            seedSetting(temp.path, 'backup_destination', dest);
            const rebuilt = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(rebuilt.deleteBackup(precious)).toBe(false);
            expect(existsSync(precious)).toBe(true);
        });

        it('deletes a file inside the resolved destination', () => {
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            const file = `${dest}/plex.2020-01-01_000000.tar.gz`;
            writeFileSync(file, 'x');
            seedSetting(temp.path, 'backup_destination', dest);

            const service = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(service.deleteBackup(file)).toBe(true);
            expect(existsSync(file)).toBe(false);
        });

        it('refuses a sibling directory whose name merely starts with the destination', () => {
            const dest = `${root}/backups`;
            const sibling = `${root}/backups-evil`;
            mkdirSync(dest, { recursive: true });
            mkdirSync(sibling, { recursive: true });
            const evilFile = `${sibling}/x.tar.gz`;
            writeFileSync(evilFile, 'x');
            seedSetting(temp.path, 'backup_destination', dest);

            const service = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(service.deleteBackup(evilFile)).toBe(false);
            expect(existsSync(evilFile)).toBe(true);
        });

        it('refuses a symlink inside the destination that resolves outside it', () => {
            const dest = `${root}/dest`;
            const outside = `${root}/outside`;
            mkdirSync(dest, { recursive: true });
            mkdirSync(outside, { recursive: true });
            const secret = `${outside}/secret.txt`;
            writeFileSync(secret, 'do not delete me');
            const link = `${dest}/plex.2020-01-01_000000.tar.gz`;
            symlinkSync(secret, link);
            seedSetting(temp.path, 'backup_destination', dest);

            const service = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(service.deleteBackup(link)).toBe(false);
            expect(existsSync(secret)).toBe(true);
        });

        it('returns false, without throwing, for a file that does not exist', () => {
            const dest = `${root}/dest`;
            mkdirSync(dest, { recursive: true });
            seedSetting(temp.path, 'backup_destination', dest);

            const service = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(service.deleteBackup(`${dest}/does-not-exist.tar.gz`)).toBe(false);
        });

        // Ported from b97b7e3 (reported to the dev branch): containment alone
        // (pathIsWithin) accepts a file nested in a subdirectory of the
        // destination; the fix requires it to sit DIRECTLY in the
        // destination (dirname(realpath(file)) === realpath(destination)).
        // This is the one case that tells the two rules apart.
        it('refuses an archive-named file in a subdirectory of the destination', () => {
            const dest = `${root}/dest`;
            const sub = `${dest}/sub`;
            mkdirSync(sub, { recursive: true });
            const nested = `${sub}/plex.2020-01-01_000000.tar.gz`;
            writeFileSync(nested, 'x');
            seedSetting(temp.path, 'backup_destination', dest);

            const service = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(service.deleteBackup(nested)).toBe(false);
            expect(existsSync(nested)).toBe(true);
        });

        // The resolved path, not the original, is what gets deleted: a
        // symlink that itself sits outside the destination's immediate
        // children (so it could never pass the dirname check directly) but
        // whose TARGET is a real archive directly in the destination should
        // delete that archive, leaving the symlink itself dangling.
        it('deletes the resolved archive when the given path is a symlink to one', () => {
            const dest = `${root}/dest`;
            const sub = `${dest}/sub`;
            mkdirSync(sub, { recursive: true });
            const real = `${dest}/blog.2020-01-01_000000.tar.gz`;
            writeFileSync(real, 'x');
            const link = `${sub}/link.tar.gz`;
            symlinkSync(real, link);
            seedSetting(temp.path, 'backup_destination', dest);

            const service = new BackupService(
                new DatabaseService(temp.path),
                fakeDocker({}).client,
                fakeTar().tar,
                [root]
            );

            expect(service.deleteBackup(link)).toBe(true);
            expect(existsSync(real)).toBe(false);
            // The symlink entry itself remains on disk — only its target was
            // unlinked, so it is now dangling. `existsSync` follows the link
            // and reports false; `lstatSync` (which does not follow it)
            // confirms the entry is still there.
            expect(existsSync(link)).toBe(false);
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
        });
    });

    describe('resolveHostPaths', () => {
        it('is empty for a container that does not exist', async () => {
            const { service } = build({});
            expect(await service.resolveHostPaths('nope', ['/config'])).toEqual([]);
        });

        it('mirrors what backupContainer would archive', async () => {
            const { service } = build({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });

            expect(await service.resolveHostPaths('plex', ['/config'])).toEqual([`${root}/appdata/plex`]);
        });
    });

    describe('destination override, PHP-parity edge case', () => {
        // PHP's `!$dest` is true for null, '', and the string '0' alike. A
        // naive `!dest` port would agree for every JS-falsy value but treats
        // '0' as truthy, so it would try to use the literal string "0" as a
        // destination instead of falling back to the stored setting.
        it('treats an override of the string "0" as "not provided", same as PHP', async () => {
            const dest = `${root}/dest-from-settings`;
            seedSetting(temp.path, 'backup_destination', dest);

            const { client } = fakeDocker({
                c1: { names: ['/plex'], mounts: mounts(root), running: true },
            });
            const service = new BackupService(new DatabaseService(temp.path), client, fakeTar().tar, [root]);

            const result = await service.backupContainer('plex', ['/config'], '0');

            expect(result.success).toBe(true);
            expect(result.backupFile?.startsWith(dest)).toBe(true);
        });
    });
});

function basename(path: string): string {
    return path.split('/').pop() ?? path;
}
