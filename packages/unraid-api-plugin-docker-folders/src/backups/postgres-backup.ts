import { Inject, Injectable } from '@nestjs/common';
import { createWriteStream, statSync, writeFileSync } from 'node:fs';
import { type Duplex, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import Dockerode from 'dockerode';

import { DOCKER_SOCKET_PATH } from '../containers/docker-client.js';
import { safePathComponent } from '../paths/paths.js';

/**
 * Postgres backup mode, ported from `classes/PostgresBackup.php` and
 * `classes/DockerStreamDemuxer.php`.
 *
 * Dumps databases with pg_dump inside the container, through Docker's exec
 * API. Nothing here runs a shell: every command is an argv array, and the
 * password travels as PGPASSWORD in the exec's environment.
 *
 * `postgres.password` is write-only. `redactConfig()` removes it from every
 * schedule the API returns and puts `password_set` in its place.
 *
 * The static rules must match the PHP class, because both backends read and
 * write the same schedules.
 */

export const MODE_FILES = 'files';
export const MODE_POSTGRES = 'postgres';
export const CREDENTIALS_ENV = 'env';
export const CREDENTIALS_CUSTOM = 'custom';

export const MAX_DATABASES = 100;
export const MAX_PASSWORD_LENGTH = 1024;

/** A dump can take hours. The limit only stops a hung exec. */
const DUMP_TIMEOUT_MS = 21_600_000;
const QUERY_TIMEOUT_MS = 30_000;
const STDERR_CAP = 65_536;
const CAPTURE_CAP = 4 * 1024 * 1024;

const USER_ENV = ['POSTGRES_USER', 'POSTGRESQL_USERNAME'];
const PASSWORD_ENV = ['POSTGRES_PASSWORD', 'POSTGRESQL_PASSWORD'];

const LIST_DATABASES_SQL =
    'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1';

/**
 * `credentials` is 'env' (the default: every run reads POSTGRES_USER and
 * POSTGRES_PASSWORD from the container) or 'custom' (user and password are
 * stored). `service` names the compose service of a stack target.
 */
export interface PostgresConfig {
    service?: string;
    credentials?: string;
    user?: string;
    password?: string | null;
    databases: string[];
}

type Config = Record<string, unknown> & { postgres?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function modeOf(config: unknown): typeof MODE_FILES | typeof MODE_POSTGRES {
    return isRecord(config) && config.mode === MODE_POSTGRES ? MODE_POSTGRES : MODE_FILES;
}

export function isValidUser(user: unknown): user is string {
    return typeof user === 'string' && /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,62}$/.test(user);
}

/**
 * A name reaches pg_dump as the value after -d. A leading "-" would read as
 * an option. libpq reads the value as a connection string when it contains
 * "=" or starts with "postgresql://" or "postgres://", which could send
 * PGPASSWORD to another host. Byte length, as PHP's strlen().
 */
export function isValidDatabaseName(name: unknown): name is string {
    return (
        typeof name === 'string' &&
        name !== '' &&
        Buffer.byteLength(name, 'utf8') <= 63 &&
        !name.startsWith('-') &&
        !name.includes('=') &&
        !name.includes('\0') &&
        !/^postgres(ql)?:\/\//i.test(name)
    );
}

/** Anything but 'custom' is 'env'. */
export function credentialsOf(pg: unknown): typeof CREDENTIALS_ENV | typeof CREDENTIALS_CUSTOM {
    return isRecord(pg) && pg.credentials === CREDENTIALS_CUSTOM ? CREDENTIALS_CUSTOM : CREDENTIALS_ENV;
}

/** A container name or a compose service name. */
export function isValidServiceName(name: unknown): name is string {
    return typeof name === 'string' && safePathComponent(name) !== null;
}

/** `PostgresBackup::validateConfig`. Answers an error message, or null. */
export function validateConfig(config: unknown, targetType: string, passwordRequired = true): string | null {
    if (!isRecord(config) || !isRecord(config.postgres)) return 'Postgres settings are missing';
    const pg = config.postgres;

    if (targetType === 'stack') {
        if (!isValidServiceName(pg.service ?? null)) return 'Pick the stack service that runs Postgres';
    } else if (targetType !== 'container') {
        return 'Invalid target type';
    }

    if (pg.credentials !== undefined && pg.credentials !== CREDENTIALS_ENV && pg.credentials !== CREDENTIALS_CUSTOM) {
        return 'Invalid credentials source';
    }

    if (credentialsOf(pg) === CREDENTIALS_CUSTOM) {
        if (!isValidUser(pg.user ?? '')) {
            return 'Postgres user must be 1-63 letters, digits, or _ . @ -, and must not start with -';
        }
        const password = pg.password ?? null;
        if (
            password !== null &&
            (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_LENGTH)
        ) {
            return 'Postgres password is too long';
        }
        if (passwordRequired && (password === null || password === '')) return 'Postgres password is required';
    }

    const databases = pg.databases;
    if (!Array.isArray(databases) || databases.length === 0) return 'Pick at least one database';
    if (databases.length > MAX_DATABASES) return `Too many databases (limit ${MAX_DATABASES})`;
    const seen = new Set<string>();
    for (const db of databases) {
        if (!isValidDatabaseName(db)) return 'Invalid database name';
        if (seen.has(db)) return `Database listed twice: ${db}`;
        seen.add(db);
    }
    return null;
}

/** `PostgresBackup::normalizeConfig`. Key order matches PHP's JSON output. */
export function normalizeConfig(config: Config, targetType: string): Record<string, unknown> {
    const pg = config.postgres as Record<string, unknown>;
    const postgres: Record<string, unknown> = {};
    if (targetType === 'stack') postgres.service = pg.service;
    postgres.credentials = credentialsOf(pg);
    if (postgres.credentials === CREDENTIALS_CUSTOM) {
        postgres.user = pg.user;
        if (typeof pg.password === 'string' && pg.password !== '') postgres.password = pg.password;
    }
    postgres.databases = [...(pg.databases as string[])];

    const out: Record<string, unknown> = { mode: MODE_POSTGRES, paths: [], postgres };
    if (config.destination) out.destination = config.destination;
    if (config.retention_count !== undefined && config.retention_count !== null && config.retention_count !== '') {
        out.retention_count = Math.trunc(Number(config.retention_count));
    }
    return out;
}

/**
 * An empty password on an update means "keep the saved one". It is kept only
 * when the user and the stack service stay the same. The caller passes no
 * stored config when the schedule's target changes.
 */
export function mergeStoredPassword(incoming: Config, stored: unknown): Config {
    if (modeOf(incoming) !== MODE_POSTGRES || !isRecord(incoming.postgres)) return incoming;
    if (credentialsOf(incoming.postgres) !== CREDENTIALS_CUSTOM) return incoming;
    if (typeof incoming.postgres.password === 'string' && incoming.postgres.password !== '') return incoming;

    let parsed = stored;
    if (typeof stored === 'string') {
        try {
            parsed = JSON.parse(stored);
        } catch {
            parsed = null;
        }
    }
    if (
        modeOf(parsed) === MODE_POSTGRES &&
        isRecord(parsed) &&
        isRecord(parsed.postgres) &&
        (parsed.postgres.user ?? null) === (incoming.postgres.user ?? null) &&
        (parsed.postgres.service ?? null) === (incoming.postgres.service ?? null)
    ) {
        const password = parsed.postgres.password;
        if (typeof password === 'string' && password !== '') {
            return { ...incoming, postgres: { ...incoming.postgres, password } };
        }
    }
    return incoming;
}

/** Remove the password and say whether one is saved. */
export function redactConfig<T>(config: T): T {
    if (!isRecord(config) || !isRecord(config.postgres)) return config;
    const { password, ...rest } = config.postgres;
    return {
        ...config,
        postgres: { ...rest, password_set: typeof password === 'string' && password !== '' },
    } as T;
}

/** Redact a stored backup_config JSON string, as PHP's formatSchedule() does. */
export function redactConfigJson(json: string | null): string | null {
    if (json === null) return null;
    try {
        const parsed = JSON.parse(json);
        // Any postgres block, whatever the mode, as PHP's redactConfig() does.
        // A client can store one on a file-mode config too.
        return isRecord(parsed) && isRecord(parsed.postgres) ? JSON.stringify(redactConfig(parsed)) : json;
    } catch {
        return json;
    }
}

/**
 * Turn a request's backup_config into the JSON string to store.
 * `ScheduleManager::prepareBackupConfig`. Throws a message on a bad config.
 */
export function prepareBackupConfig(json: string, targetType: string, storedJson: string | null): string {
    let decoded: unknown;
    try {
        decoded = JSON.parse(json);
    } catch {
        throw new Error('Invalid backup_config');
    }
    if (!isRecord(decoded)) throw new Error('Invalid backup_config');
    if (modeOf(decoded) !== MODE_POSTGRES) return json;

    const merged = mergeStoredPassword(decoded as Config, storedJson);
    const error = validateConfig(merged, targetType);
    if (error !== null) throw new Error(error);
    return JSON.stringify(normalizeConfig(merged, targetType));
}

export function envValue(env: string[], names: string[]): string | null {
    for (const name of names) {
        for (const entry of env) {
            if (typeof entry === 'string' && entry.startsWith(`${name}=`)) return entry.slice(name.length + 1);
        }
    }
    return null;
}

/** PG_MAJOR/PG_VERSION for the official image family, BITNAMI_APP_NAME for Bitnami. */
export function envLooksLikePostgres(env: string[]): boolean {
    if (envValue(env, ['PG_MAJOR', 'PG_VERSION']) !== null) return true;
    const bitnami = envValue(env, ['BITNAMI_APP_NAME']);
    return bitnami !== null && bitnami.toLowerCase().startsWith('postgres');
}

// ---------------------------------------------------------------------------
// Docker exec
// ---------------------------------------------------------------------------

/**
 * Splits Docker's multiplexed exec stream. Each frame has an 8-byte header:
 * byte 0 is the stream (1 stdout, 2 stderr), bytes 4-7 the payload length.
 * A TTY would send plain bytes but turn "\n" into "\r\n", which corrupts a
 * binary dump, so exec never uses one.
 */
export class DockerStreamDemuxer {
    private buffer: Buffer = Buffer.alloc(0);

    constructor(
        private readonly onStdout: (chunk: Buffer) => void,
        private readonly onStderr: (chunk: Buffer) => void
    ) {}

    feed(chunk: Buffer): void {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 8) {
            const length = this.buffer.readUInt32BE(4);
            if (this.buffer.length < 8 + length) break;
            const stream = this.buffer[0];
            const payload = this.buffer.subarray(8, 8 + length);
            this.buffer = this.buffer.subarray(8 + length);
            if (stream === 2) this.onStderr(payload);
            else this.onStdout(payload);
        }
    }

    hasPartialFrame(): boolean {
        return this.buffer.length > 0;
    }
}

export interface ExecResult {
    ok: boolean;
    exitCode: number | null;
    stderr: string;
    error: string;
}

export interface CaptureResult extends ExecResult {
    stdout: string;
}

/** The slice of Docker this mode needs. Injected so tests can fake it. */
export interface PgExecClient {
    /** The containers that carry every one of `labels`, from the list endpoint's own filter. */
    findByLabels(labels: Record<string, string>): Promise<{ id: string; name: string }[]>;
    inspect(container: string): Promise<{ id: string; name: string; env: string[]; running: boolean } | null>;
    /** Runs `cmd`, streaming stdout into `sink`, honoring its backpressure. */
    exec(container: string, cmd: string[], env: string[], sink: Writable, timeoutMs: number): Promise<ExecResult>;
}

export const PG_EXEC_CLIENT_TOKEN = 'DOCKER_FOLDERS_PG_EXEC_CLIENT';

export function createPgExecClient(): PgExecClient {
    const docker = new Dockerode({ socketPath: DOCKER_SOCKET_PATH });
    return {
        async findByLabels(labels) {
            const label = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
            const list = await docker.listContainers({ all: true, filters: { label } });
            return list.map((c) => ({ id: c.Id, name: (c.Names?.[0] ?? '').replace(/^\//, '') }));
        },

        async inspect(container) {
            try {
                const info = await docker.getContainer(container).inspect();
                return {
                    id: info.Id,
                    name: (info.Name ?? '').replace(/^\//, ''),
                    env: info.Config?.Env ?? [],
                    running: Boolean(info.State?.Running),
                };
            } catch {
                return null;
            }
        },

        async exec(container, cmd, env, sink, timeoutMs) {
            const result: ExecResult = { ok: false, exitCode: null, stderr: '', error: '' };
            let exec: Dockerode.Exec;
            let stream: Duplex;
            try {
                exec = await docker.getContainer(container).exec({
                    Cmd: cmd,
                    Env: env,
                    AttachStdin: false,
                    AttachStdout: true,
                    AttachStderr: true,
                    Tty: false,
                });
                stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
            } catch (error) {
                result.error = describeDockerError(error);
                return result;
            }

            const pumped = await pumpExecStream(stream, sink, timeoutMs);
            result.stderr = pumped.stderr;
            if (pumped.error !== '') {
                result.error = pumped.error;
                return result;
            }

            // Docker can report Running with no ExitCode for a moment after
            // the stream ends. Wait a few seconds for the real code.
            try {
                let info = await exec.inspect();
                for (let i = 0; i < 50 && info.Running; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    info = await exec.inspect();
                }
                result.exitCode = info.ExitCode ?? null;
            } catch {
                result.error = 'Could not read the exit code';
                return result;
            }
            result.ok = result.exitCode === 0;
            return result;
        },
    };
}

/**
 * Read a multiplexed exec stream to its end. Stdout goes to `sink` with its
 * backpressure honored; stderr is kept up to STDERR_CAP.
 *
 * A sink that fails (a full disk) never emits 'drain', so waiting on it would
 * hang until the timeout. A sink error closes the stream at once instead.
 * The command in the container then ends, because its next write fails.
 * Reading on would run it to its end and throw the output away.
 */
export async function pumpExecStream(
    stream: NodeJS.ReadableStream & { destroy?: () => void },
    sink: Writable,
    timeoutMs: number
): Promise<{ error: string; stderr: string }> {
    let stderr = '';
    let sinkError = '';
    let waiting = false;

    const resume = () => {
        waiting = false;
        stream.resume();
    };
    sink.on('error', (error: Error) => {
        if (sinkError === '') sinkError = error.message;
        stream.destroy?.();
    });

    const demuxer = new DockerStreamDemuxer(
        (payload) => {
            if (sinkError !== '') return;
            if (!sink.write(payload) && !waiting) {
                waiting = true;
                stream.pause();
                sink.once('drain', resume);
            }
        },
        (payload) => {
            if (stderr.length < STDERR_CAP) stderr += payload.toString('utf8').slice(0, STDERR_CAP - stderr.length);
        }
    );

    const streamError = await new Promise<string>((resolve) => {
        let done = false;
        const finish = (message: string) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(message);
        };
        const timer = setTimeout(() => {
            stream.destroy?.();
            finish('The command timed out');
        }, timeoutMs);
        stream.on('data', (chunk: Buffer) => demuxer.feed(chunk));
        stream.on('end', () => finish(''));
        stream.on('close', () => finish(''));
        stream.on('error', (error: Error) => finish(`Docker API error: ${error.message}`));
    });

    if (streamError !== '') return { error: streamError, stderr };
    if (sinkError !== '') return { error: `Could not write the output: ${sinkError}`, stderr };
    if (demuxer.hasPartialFrame()) return { error: 'The output stream ended early', stderr };
    return { error: '', stderr };
}

function describeDockerError(error: unknown): string {
    const e = error as { statusCode?: number; json?: { message?: string }; message?: string } | null;
    const message = e?.json?.message ?? e?.message ?? String(error);
    return e?.statusCode ? `Docker API HTTP ${e.statusCode}: ${message}` : `Docker API error: ${message}`;
}

/** A Writable that keeps up to `cap` bytes as a string. */
class CaptureSink extends Writable {
    private chunks: Buffer[] = [];
    private size = 0;

    constructor(private readonly cap: number) {
        super();
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
        if (this.size < this.cap) {
            this.chunks.push(chunk);
            this.size += chunk.length;
        }
        done();
    }

    text(): string {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface PostgresInfo {
    is_postgres: boolean;
    running: boolean;
    env_user: string;
    has_env_password: boolean;
}

export interface PostgresTarget {
    id: string;
    name: string;
    /** The archive prefix: the container name, or "<project>.<service>". */
    prefix: string;
}

export interface DatabaseList {
    success: boolean;
    databases: string[];
    message: string;
}

@Injectable()
export class PostgresBackupService {
    constructor(@Inject(PG_EXEC_CLIENT_TOKEN) private readonly docker: PgExecClient) {}

    async info(container: string): Promise<PostgresInfo | null> {
        const inspected = await this.docker.inspect(container);
        if (inspected === null) return null;
        const user = envValue(inspected.env, USER_ENV);
        const password = envValue(inspected.env, PASSWORD_ENV);
        return {
            is_postgres: envLooksLikePostgres(inspected.env),
            running: inspected.running,
            env_user: user !== null && user !== '' ? user : 'postgres',
            has_env_password: password !== null && password !== '',
        };
    }

    /** `PostgresBackup::resolveTarget`. A stack resolves its service through the compose labels. */
    async resolveTarget(targetType: string, targetId: string, service: string | null = null): Promise<PostgresTarget | null> {
        if (targetType === 'container') {
            // Inspect also answers to an id or an id prefix, so the name must match.
            const inspected = await this.docker.inspect(targetId);
            return inspected?.name === targetId ? { id: inspected.id, name: targetId, prefix: targetId } : null;
        }
        const [found] = await this.docker.findByLabels({
            'com.docker.compose.project': targetId,
            'com.docker.compose.service': service ?? '',
        });
        return found ? { id: found.id, name: found.name, prefix: `${targetId}.${service}` } : null;
    }

    /**
     * `PostgresBackup::resolveCredentials`. With 'env', read from the
     * container on every call. A missing POSTGRES_PASSWORD is not an error:
     * the official image trusts local connections.
     */
    async resolveCredentials(container: string, pg: Partial<PostgresConfig>): Promise<{ user: string; password: string | null }> {
        if (credentialsOf(pg) === CREDENTIALS_CUSTOM) {
            return {
                user: pg.user ?? '',
                password: typeof pg.password === 'string' && pg.password !== '' ? pg.password : null,
            };
        }
        const env = (await this.docker.inspect(container))?.env ?? [];
        const user = envValue(env, USER_ENV);
        const password = envValue(env, PASSWORD_ENV);
        return {
            user: user !== null && user !== '' ? user : 'postgres',
            password: password !== null && password !== '' ? password : null,
        };
    }

    async listDatabases(container: string, user: string, password: string | null): Promise<DatabaseList> {
        if (!isValidUser(user)) return { success: false, databases: [], message: 'Invalid Postgres user' };

        const run = await this.capture(
            container,
            ['psql', '-U', user, '-d', 'postgres', '-X', '-A', '-t', '-c', LIST_DATABASES_SQL],
            connectionEnv(password),
            QUERY_TIMEOUT_MS
        );
        if (!run.ok) return { success: false, databases: [], message: describeFailure(run, 'psql') };

        return { success: true, databases: run.stdout.split(/\r?\n/).filter((line) => line !== ''), message: '' };
    }

    /** Dump each database into `stagingDir` as 01.dump, 02.dump, ..., plus manifest.json. */
    async dumpAll(container: string, pg: PostgresConfig, stagingDir: string): Promise<{ success: boolean; message: string }> {
        const credentials = await this.resolveCredentials(container, pg);
        if (!isValidUser(credentials.user)) {
            return { success: false, message: 'The container env holds an invalid Postgres user' };
        }
        const env = connectionEnv(credentials.password);

        const version = await this.capture(container, ['pg_dump', '--version'], [], QUERY_TIMEOUT_MS);
        if (!version.ok) return { success: false, message: describeFailure(version, 'pg_dump') };

        const dir = stagingDir.replace(/\/+$/, '');
        const manifest = {
            format: 'pg_dump custom (-Fc), restore with pg_restore',
            container,
            user: credentials.user,
            pg_dump_version: version.stdout.trim(),
            created_at: new Date().toISOString(),
            databases: [] as { file: string; database: string; size: number }[],
        };

        let i = 0;
        for (const database of pg.databases) {
            i++;
            const file = `${String(i).padStart(2, '0')}.dump`;
            const path = `${dir}/${file}`;
            const out = createWriteStream(path, { mode: 0o600 });
            let writeError = '';
            out.on('error', (error) => {
                writeError = error.message;
            });

            const run = await this.docker.exec(
                container,
                ['pg_dump', '-U', credentials.user, '-Fc', '-d', database],
                env,
                out,
                DUMP_TIMEOUT_MS
            );
            out.end();
            // Rejects when the write stream failed, which writeError already holds.
            await finished(out).catch(() => undefined);

            if (writeError !== '') {
                return { success: false, message: `Database ${database}: could not write the dump (disk full?)` };
            }
            if (!run.ok) {
                return { success: false, message: `Database ${database}: ${describeFailure(run, 'pg_dump')}` };
            }
            manifest.databases.push({ file, database, size: statSync(path).size });
        }

        try {
            writeFileSync(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 4)}\n`);
        } catch {
            return { success: false, message: 'Cannot write manifest.json' };
        }
        return { success: true, message: '' };
    }

    private async capture(container: string, cmd: string[], env: string[], timeoutMs: number): Promise<CaptureResult> {
        const sink = new CaptureSink(CAPTURE_CAP);
        const run = await this.docker.exec(container, cmd, env, sink, timeoutMs);
        return { ...run, stdout: sink.text() };
    }
}

function connectionEnv(password: string | null): string[] {
    return password !== null && password !== '' ? [`PGPASSWORD=${password}`] : [];
}

/** Word a failed exec: the first stderr line, or why the exec itself failed. */
export function describeFailure(run: ExecResult, tool: string): string {
    if (run.error !== '') {
        if (/is not running/i.test(run.error) || run.error.includes('HTTP 409')) return 'The container is not running';
        return run.error;
    }
    if (run.exitCode === 126 || run.exitCode === 127) {
        return `${tool} was not found in the container. Is this a Postgres container?`;
    }
    const stderr = run.stderr.trim();
    if (stderr !== '') return stderr.split('\n')[0].trim();
    return `${tool} exited with code ${run.exitCode}`;
}
