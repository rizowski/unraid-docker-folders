import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import { createMigratedDatabase, seedSetting, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { BackupService, createTarRunner, type BackupDockerClient } from '../backup.service.js';
import {
    DockerStreamDemuxer,
    type ExecResult,
    archivePrefixesFor,
    envLooksLikePostgres,
    fileNameOf,
    mergeStoredPassword,
    normalizeConfig,
    type PgExecClient,
    PostgresBackupService,
    prepareBackupConfig,
    pumpExecStream,
    redactConfig,
    redactConfigJson,
    validateConfig,
} from '../postgres-backup.js';

/** Ported case for case from `tests/php/DockerExecDemuxTest.php` and `PostgresBackupTest.php`. */

function frame(stream: number, payload: string | Buffer): Buffer {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'binary');
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}

describe('DockerStreamDemuxer', () => {
    function demux() {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const d = new DockerStreamDemuxer(
            (b) => out.push(Buffer.from(b)),
            (b) => err.push(Buffer.from(b))
        );
        return { d, out: () => Buffer.concat(out), err: () => Buffer.concat(err).toString() };
    }

    it('splits stdout and stderr', () => {
        const { d, out, err } = demux();
        d.feed(Buffer.concat([frame(1, 'hello '), frame(2, 'warn'), frame(1, 'world')]));
        expect(out().toString()).toBe('hello world');
        expect(err()).toBe('warn');
        expect(d.hasPartialFrame()).toBe(false);
    });

    it('joins a frame split at every byte, binary intact', () => {
        const payload = Buffer.concat([Buffer.from('PGDMP\r\n\0\x01\xff', 'binary'), Buffer.alloc(300, 'x')]);
        const stream = Buffer.concat([frame(1, payload), frame(2, 'err')]);
        const { d, out, err } = demux();
        for (let i = 0; i < stream.length; i++) d.feed(stream.subarray(i, i + 1));
        expect(out().equals(payload)).toBe(true);
        expect(err()).toBe('err');
        expect(d.hasPartialFrame()).toBe(false);
    });

    it('reports a truncated stream', () => {
        const { d, out } = demux();
        d.feed(frame(1, 'abcdef').subarray(0, 10));
        expect(out().length).toBe(0);
        expect(d.hasPartialFrame()).toBe(true);
    });
});

describe('pumpExecStream', () => {
    it('waits for drain on a slow sink and delivers every byte', async () => {
        const stream = new PassThrough();
        const received: Buffer[] = [];
        // highWaterMark 1 makes every write report backpressure.
        const sink = new Writable({
            highWaterMark: 1,
            write(chunk, _enc, done) {
                received.push(chunk);
                setTimeout(done, 1);
            },
        });
        const pumping = pumpExecStream(stream, sink, 5000);
        for (let i = 0; i < 20; i++) stream.write(frame(1, `chunk${i};`));
        stream.write(frame(2, 'note'));
        stream.end();

        const result = await pumping;
        expect(result).toEqual({ error: '', stderr: 'note' });
        await new Promise((r) => setTimeout(r, 50));
        expect(Buffer.concat(received).toString()).toBe(Array.from({ length: 20 }, (_, i) => `chunk${i};`).join(''));
    });

    it('closes the stream at once when the sink fails', async () => {
        const stream = new PassThrough();
        const sink = new Writable({
            write(_chunk, _enc, done) {
                done(new Error('ENOSPC: no space left on device'));
            },
        });
        const pumping = pumpExecStream(stream, sink, 5000);
        stream.write(frame(1, 'x'));
        // Never ended by the writer: only the sink error can finish the pump.
        const result = await pumping;
        expect(result.error).toBe('Could not write the output: ENOSPC: no space left on device');
        expect(stream.destroyed).toBe(true);
    });

    it('does not hang when the sink fails while paused', async () => {
        const stream = new PassThrough();
        const sink = new Writable({
            highWaterMark: 1,
            write(_chunk, _enc, done) {
                setTimeout(() => done(new Error('ENOSPC: no space left on device')), 1);
            },
        });
        const pumping = pumpExecStream(stream, sink, 5000);
        for (let i = 0; i < 20; i++) stream.write(frame(1, 'x'.repeat(100)));
        stream.end();

        const result = await pumping;
        expect(result.error).toBe('Could not write the output: ENOSPC: no space left on device');
    });

    it('times out a stream that never ends', async () => {
        const result = await pumpExecStream(new PassThrough(), new PassThrough(), 20);
        expect(result.error).toBe('The command timed out');
    });
});

const config = (pg: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    mode: 'postgres',
    paths: [],
    postgres: { credentials: 'custom', user: 'postgres', password: 'secret', databases: ['app'], ...pg },
    ...extra,
});

describe('config rules', () => {
    it('accepts a valid config', () => {
        expect(validateConfig(config(), 'container')).toBeNull();
        // Env credentials need no user or password, and no key at all means env.
        expect(validateConfig(config({ credentials: 'env', user: null, password: null }), 'container')).toBeNull();
        expect(validateConfig({ postgres: { databases: ['app'] } }, 'container')).toBeNull();
        expect(validateConfig(config({ credentials: 'vault' }), 'container')).not.toBeNull();
    });

    it('needs a service for a stack', () => {
        expect(validateConfig(config(), 'stack')).not.toBeNull();
        expect(validateConfig(config({ service: '../x' }), 'stack')).not.toBeNull();
        expect(validateConfig(config({ service: 'database' }), 'stack')).toBeNull();
    });

    it.each([
        ['-Fp'],
        ['host=evil dbname=x'],
        [''],
        ['a'.repeat(64)],
        ['a\0b'],
        [5],
        ['postgresql://evil/x'],
        ['POSTGRES://evil/x'],
    ])(
        'rejects the unsafe database name %j',
        (name) => {
            expect(validateConfig(config({ databases: [name] }), 'container')).not.toBeNull();
        }
    );

    it('allows a slash in a database name, because the file name is sanitized', () => {
        expect(validateConfig(config({ databases: ['../etc/x'] }), 'container')).toBeNull();
        expect(fileNameOf('../etc/x')).toBe('etc-x');
    });

    it('refuses databases that share a file name, as PHP does', () => {
        expect(validateConfig(config({ databases: ['my db', 'my-db'] }), 'container')).toBe(
            'Databases my db and my-db map to the same file name'
        );
        expect(validateConfig(config({ databases: ['___'] }), 'container')).toBe(
            'Database ___ has no letters or digits to name its backup file'
        );
    });

    it("lists the archive prefixes of a container's Postgres schedules", () => {
        const schedules = [
            { target_id: 'db', backup_config: JSON.stringify(config({ databases: ['app', 'my db'] })) },
            { target_id: 'db', backup_config: JSON.stringify({ paths: ['/config'] }) },
            { target_id: 'other', backup_config: JSON.stringify(config({ databases: ['x'] })) },
            { target_id: 'db', backup_config: null },
        ];
        expect(archivePrefixesFor(schedules, 'container', 'db')).toEqual(['db.app', 'db.my-db']);
        expect(archivePrefixesFor(schedules, 'stack', 'db')).toEqual([]);
    });

    it('rejects bad users, duplicates and a missing password', () => {
        expect(validateConfig(config({ user: '-U' }), 'container')).not.toBeNull();
        expect(validateConfig(config({ user: 'a b' }), 'container')).not.toBeNull();
        expect(validateConfig(config({ databases: ['a', 'a'] }), 'container')).not.toBeNull();
        expect(validateConfig(config({ databases: [] }), 'container')).not.toBeNull();
        expect(validateConfig(config({ password: '' }), 'container')).not.toBeNull();
        expect(validateConfig(config({ password: '' }), 'container', false)).toBeNull();
        expect(validateConfig(config({ password: 'x'.repeat(1025) }), 'container')).not.toBeNull();
    });

    it('normalize keeps only known keys', () => {
        expect(
            normalizeConfig(
                config(
                    { extra: 1, service: 'dropped' },
                    { quiesce: 'stop', destination: '/mnt/user/b', retention_count: '3', junk: true }
                ),
                'container'
            )
        ).toEqual({
            mode: 'postgres',
            paths: [],
            postgres: { credentials: 'custom', user: 'postgres', password: 'secret', databases: ['app'] },
            destination: '/mnt/user/b',
            retention_count: 3,
        });
    });

    it('stores no credentials for env, and the service of a stack', () => {
        expect(normalizeConfig(config({ credentials: 'env' }), 'container').postgres).toEqual({
            credentials: 'env',
            databases: ['app'],
        });
        expect((normalizeConfig(config({ service: 'database' }), 'stack').postgres as { service: string }).service).toBe(
            'database'
        );
    });

    it('redacts a password in any postgres block, whatever the mode, as PHP does', () => {
        const json = JSON.stringify({ mode: 'files', paths: ['/data'], postgres: { password: 'x' } });
        expect(JSON.parse(redactConfigJson(json) as string).postgres).toEqual({ password_set: true });
        const files = '{"paths":["/data"]}';
        expect(redactConfigJson(files)).toBe(files);
    });

    it('redacts the password', () => {
        const out = redactConfig(config()) as { postgres: Record<string, unknown> };
        expect(out.postgres.password).toBeUndefined();
        expect(out.postgres.password_set).toBe(true);
        const files = { paths: ['/data'] };
        expect(redactConfig(files)).toBe(files);
    });

    it('keeps the stored password only when left out', () => {
        const stored = JSON.stringify(config({ password: 'old' }));
        const pw = (c: unknown) => (c as { postgres: { password: string } }).postgres.password;
        expect(pw(mergeStoredPassword(config({ password: '' }), stored))).toBe('old');
        expect(pw(mergeStoredPassword(config({ password: 'new' }), stored))).toBe('new');
        expect(pw(mergeStoredPassword(config({ password: '', credentials: 'env' }), stored))).toBe('');
    });

    it('keeps no password for another user or service', () => {
        const stored = JSON.stringify(config({ password: 'old', service: 'db' }));
        const pw = (c: unknown) => (c as { postgres: { password: string } }).postgres.password;
        expect(pw(mergeStoredPassword(config({ password: '', service: 'db', user: 'other' }), stored))).toBe('');
        expect(pw(mergeStoredPassword(config({ password: '', service: 'db2' }), stored))).toBe('');
        expect(pw(mergeStoredPassword(config({ password: '', service: 'db' }), stored))).toBe('old');
    });

    it('prepare refuses a stack with no service and a new schedule with no password, and leaves file mode alone', () => {
        expect(() => prepareBackupConfig(JSON.stringify(config()), 'stack', null)).toThrow();
        expect(JSON.parse(prepareBackupConfig(JSON.stringify(config({ service: 'database' })), 'stack', null)).postgres.service).toBe(
            'database'
        );
        expect(() => prepareBackupConfig(JSON.stringify(config({ password: '' })), 'container', null)).toThrow();
        const files = '{"paths":["/config"],"quiesce":"pause"}';
        expect(prepareBackupConfig(files, 'container', null)).toBe(files);
    });

    it('detects Postgres from env', () => {
        expect(envLooksLikePostgres(['PG_MAJOR=16'])).toBe(true);
        expect(envLooksLikePostgres(['BITNAMI_APP_NAME=postgresql'])).toBe(true);
        expect(envLooksLikePostgres(['PATH=/bin', 'POSTGRES_PASSWORD=x'])).toBe(false);
    });
});

/** Records every exec and answers from a script, as the PHP suite's FakePostgresDocker. */
function fakeExec(answers: Record<string, ExecResult> = {}) {
    const calls: { cmd: string[]; env: string[] }[] = [];
    const state = { env: ['PG_MAJOR=16', 'POSTGRES_USER=app', 'POSTGRES_PASSWORD=from-env'] };
    const client: PgExecClient = {
        async findByLabels(labels) {
            return labels['com.docker.compose.project'] === 'immich' && labels['com.docker.compose.service'] === 'database'
                ? [{ id: 'id-stack', name: 'immich-database-1' }]
                : [];
        },
        async inspect(container) {
            const known: Record<string, { id: string; name: string }> = {
                db: { id: 'id-db', name: 'db' },
                'id-db': { id: 'id-db', name: 'db' },
                'id-stack': { id: 'id-stack', name: 'immich-database-1' },
            };
            return known[container] ? { ...known[container], env: state.env, running: true } : null;
        },
        async exec(_container, cmd, env, sink: Writable) {
            calls.push({ cmd, env });
            const ok: ExecResult = { ok: true, exitCode: 0, stderr: '', error: '' };
            if (cmd[0] === 'pg_dump' && cmd[1] === '--version') {
                if (answers.version) return answers.version;
                sink.write(Buffer.from('pg_dump (PostgreSQL) 16.4\n'));
                return ok;
            }
            if (cmd[0] === 'psql') {
                sink.write(Buffer.from('app\npostgres\n'));
                return ok;
            }
            const db = cmd[cmd.length - 1];
            if (answers[db]) return answers[db];
            sink.write(Buffer.from(`PGDMP-${db}`));
            return ok;
        },
    };
    return { client, calls, state };
}

describe('PostgresBackupService', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pg-backup-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('info never returns the password', async () => {
        const { client } = fakeExec();
        expect(await new PostgresBackupService(client).info('db')).toEqual({
            is_postgres: true,
            running: true,
            env_user: 'app',
            has_env_password: true,
        });
    });

    it('resolves a container or a stack service', async () => {
        const svc = new PostgresBackupService(fakeExec().client);
        expect(await svc.resolveTarget('container', 'db')).toEqual({ id: 'id-db', name: 'db', prefix: 'db' });
        expect(await svc.resolveTarget('stack', 'immich', 'database')).toEqual({
            id: 'id-stack',
            name: 'immich-database-1',
            prefix: 'immich.database',
        });
        expect(await svc.resolveTarget('stack', 'immich', 'redis')).toBeNull();
        expect(await svc.resolveTarget('container', 'immich')).toBeNull();
    });

    it('reads env credentials from the container, with the postgres user as fallback', async () => {
        const { client, state } = fakeExec();
        const svc = new PostgresBackupService(client);
        expect(await svc.resolveCredentials('db', { credentials: 'env' })).toEqual({ user: 'app', password: 'from-env' });
        state.env = ['PG_MAJOR=16'];
        expect(await svc.resolveCredentials('db', { credentials: 'env' })).toEqual({ user: 'postgres', password: null });
        expect(
            await svc.resolveCredentials('db', { credentials: 'custom', user: 'backup', password: 'pw' })
        ).toEqual({ user: 'backup', password: 'pw' });
    });

    it('lists databases with the password in env only', async () => {
        const { client, calls } = fakeExec();
        const result = await new PostgresBackupService(client).listDatabases('db', 'app', 'pw');
        expect(result.databases).toEqual(['app', 'postgres']);
        expect(calls[0].env).toEqual(['PGPASSWORD=pw']);
        expect(calls[0].cmd).not.toContain('pw');
    });

    it('writes a sanitized file and a manifest for one database', async () => {
        const { client, calls } = fakeExec();
        const svc = new PostgresBackupService(client);
        const prepared = await svc.prepareDump('db', { credentials: 'env', databases: ['../evil'] });
        if (!prepared.success) throw new Error(prepared.message);

        const result = await svc.dumpOne('db', prepared, '../evil', dir);
        expect(result).toEqual({ success: true, message: '' });
        expect(readFileSync(join(dir, 'evil.dump'), 'utf8')).toBe('PGDMP-../evil');
        const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
        expect(manifest).toMatchObject({
            database: '../evil',
            file: 'evil.dump',
            user: 'app',
            pg_dump_version: 'pg_dump (PostgreSQL) 16.4',
        });
        expect(calls[1].cmd).toEqual(['pg_dump', '-U', 'app', '-Fc', '-d', '../evil']);
        expect(calls[1].env).toEqual(['PGPASSWORD=from-env']);
        expect(readdirSync(dir).sort()).toEqual(['evil.dump', 'manifest.json']);
    });

    it('reports why a database failed, without the password', async () => {
        const { client } = fakeExec({
            missing: { ok: false, exitCode: 1, error: '', stderr: 'pg_dump: error: database "missing" does not exist\nmore' },
        });
        const svc = new PostgresBackupService(client);
        const prepared = await svc.prepareDump('db', { credentials: 'custom', user: 'app', password: 'pw' });
        if (!prepared.success) throw new Error(prepared.message);

        const result = await svc.dumpOne('db', prepared, 'missing', dir);
        expect(result).toEqual({ success: false, message: 'pg_dump: error: database "missing" does not exist' });
    });

    it('explains a missing pg_dump', async () => {
        const { client } = fakeExec({ version: { ok: false, exitCode: 127, stderr: '', error: '' } });
        const result = await new PostgresBackupService(client).prepareDump('db', {
            credentials: 'custom',
            user: 'a',
            password: 'p',
        });
        expect(result.success).toBe(false);
        expect(result.message).toContain('pg_dump was not found');
    });
});

describe('BackupService.backupPostgres', () => {
    let temp: TempDatabase;
    let root: string;
    beforeEach(() => {
        temp = createMigratedDatabase();
        root = mkdtempSync(join(tmpdir(), 'pg-archive-'));
    });
    afterEach(() => {
        temp.cleanup();
        rmSync(root, { recursive: true, force: true });
    });

    const docker: BackupDockerClient = {
        listContainers: async () => [{ Id: 'id-db', Names: ['/db'] }],
        getContainer: () => {
            throw new Error('Postgres mode never quiesces');
        },
    };

    function service(answers: Record<string, ExecResult> = {}) {
        return new BackupService(
            new DatabaseService(temp.path),
            docker,
            createTarRunner(),
            [root],
            new PostgresBackupService(fakeExec(answers).client)
        );
    }

    const stamp = '\\d{4}-\\d{2}-\\d{2}_\\d{6}';

    it('writes one archive per database, each with its dump and manifest', async () => {
        const result = await service().backupPostgres('container', 'db', { databases: ['app', 'my db'] }, root, 3);

        expect(result.success).toBe(true);
        expect(result.message).toMatch(
            new RegExp(`^Backup created: db\\.app\\.${stamp}\\.tar\\.gz, db\\.my-db\\.${stamp}\\.tar\\.gz$`)
        );
        const names = readdirSync(root).sort();
        expect(names).toHaveLength(2);
        expect(names.filter((n) => n.startsWith('.dfm-staging'))).toEqual([]);
        const listing = execFileSync('tar', ['tzf', join(root, names[1])], { encoding: 'utf8' })
            .split('\n')
            .filter((l) => l !== '' && l !== './')
            .sort();
        expect(listing).toEqual(['./manifest.json', './my-db.dump']);
    });

    it('names a stack archive after the project, service and database', async () => {
        const result = await service().backupPostgres('stack', 'immich', { service: 'database', databases: ['app'] }, root, 3);
        expect(result.message).toMatch(new RegExp(`^Backup created: immich\\.database\\.app\\.${stamp}\\.tar\\.gz$`));

        const missing = await service().backupPostgres('stack', 'immich', { service: 'redis', databases: ['app'] }, root, 3);
        expect(missing).toEqual({ success: false, message: "Service 'redis' not found in stack 'immich'" });
    });

    it('backs up the other databases when one fails, and fails the run', async () => {
        const result = await service({ missing: { ok: false, exitCode: 1, error: '', stderr: 'boom' } }).backupPostgres(
            'container',
            'db',
            { databases: ['missing', 'app'] },
            root,
            3
        );

        expect(result.success).toBe(false);
        expect(result.message).toMatch(
            new RegExp(`^Postgres backup failed for 1 of 2 databases: missing: boom\\. Created: db\\.app\\.${stamp}\\.tar\\.gz$`)
        );
        const names = readdirSync(root);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^db\.app\./);
    });

    it('keeps Keep per database, apart from other series and file-mode archives', async () => {
        const old = ['db.app.2020-01-01_000000.tar.gz', 'db.app.2020-01-02_000000.tar.gz', 'db.other.2020-01-01_000000.tar.gz', 'db.2020-01-01_000000.tar.gz'];
        old.forEach((name, i) => {
            writeFileSync(join(root, name), 'x');
            const at = new Date(Date.UTC(2020, 0, 1 + i));
            utimesSync(join(root, name), at, at);
        });

        const result = await service().backupPostgres('container', 'db', { databases: ['app'] }, root, 2);

        expect(result.success).toBe(true);
        expect(result.message).toMatch(/, pruned 1 old backup\(s\)$/);
        const names = readdirSync(root);
        expect(names).not.toContain('db.app.2020-01-01_000000.tar.gz');
        expect(names).toEqual(expect.arrayContaining(old.slice(1)));
    });

    it('lists the database series of a container only when asked by prefix', async () => {
        seedSetting(temp.path, 'backup_destination', root);
        await service().backupPostgres('container', 'db', { databases: ['app'] }, root, 3);
        writeFileSync(join(root, 'db.web.2020-01-01_000000.tar.gz'), 'x');

        await service().backupPostgres('stack', 'immich', { service: 'database', databases: ['app'] }, root, 3);

        const svc = service();
        // A stack's own scope already takes the extra database segment.
        const stack = svc.listBackups('stack', 'immich').map((b) => b.filename);
        expect(stack).toHaveLength(1);
        expect(stack[0]).toMatch(/^immich\.database\.app\./);

        expect(svc.listBackups('container', 'db')).toEqual([]);
        const listed = svc.listBackups('container', 'db', ['db.app']).map((b) => b.filename);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatch(/^db\.app\./);
    });
});
