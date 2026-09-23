import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import { spawn } from 'node:child_process';
import {
    closeSync,
    existsSync,
    globSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    realpathSync,
    statSync,
    unlinkSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import Dockerode from 'dockerode';

import { DOCKER_SOCKET_PATH } from '../containers/docker-client.js';
import { DatabaseService } from '../db/database.service.js';
import { normalizePath, pathIsWithin, pathIsWithinAny, sanitizeArchivePrefix } from '../paths/paths.js';

/**
 * Container filesystem backups, ported from `classes/BackupManager.php`.
 *
 * This runs `tar` as root against paths derived from Docker mount labels, so
 * three rules are load-bearing throughout this file:
 *
 * 1. **No shell strings.** `tar` runs through `child_process.spawn` with an
 *    argv array, never a template string and never `{ shell: true }`. A mount
 *    source or container name reaching a shell string would be the Node
 *    equivalent of the PHP side's escapeshellarg() rule, minus the escaping —
 *    an argv array has no metacharacters to escape in the first place.
 * 2. **Every path from the database or a request goes through `paths.ts`.**
 *    `resolveDestination` normalizes and checks the configured destination
 *    against the allowed roots before anything is created or deleted under
 *    it; `resolveHostPathsForContainer` checks a mount's `Source` the same
 *    way before it reaches `hostPaths`.
 * 3. **Archive naming, listing, and pruning all sanitize through the same
 *    function** (`sanitizeArchivePrefix`, from `paths.ts`). If naming and
 *    finding ever used different sanitizers, a written archive would stop
 *    matching the pattern used to find and prune it later.
 *
 * One deliberate exception to rule 2: `mapContainerPath` does NOT use
 * `pathIsWithin` for the container-side match. See its doc comment — it is a
 * string match against Docker's own mount table, not a filesystem containment
 * check, and the filesystem-facing check still happens at the caller.
 *
 * Kept behaviorally identical to the PHP class, not improved. Several PHP
 * behaviors ported here are bugs, not features — each is called out at the
 * point it is reproduced, and summarized for the reader integrating this
 * service in the port's handoff report. Do not silently fix them here: the
 * two backends read and write the same archives on disk while both exist, and
 * a behavior difference is a difference in what each mode will accept or
 * delete.
 *
 * No PHP `register_shutdown_function` equivalent. PHP registers a
 * best-effort restore for a container this process paused/stopped, to run
 * even if PHP fatals before `withQuiesce`'s `finally` gets a chance to run.
 * Node has no analog: `process.on('exit')` cannot await the Docker calls a
 * restore needs, `beforeExit` does not fire on an uncaught exception or a
 * killed process (the cases that matter), and this process is long-lived and
 * shared across requests, unlike PHP-FPM's one-process-per-request model —
 * hooking a global crash handler here to fix one stuck container risks
 * interfering with unrelated in-flight work, and Node's own docs advise
 * against resuming normal operation after `uncaughtException`. The
 * `try`/`finally` in `withQuiesce` below is the real safety net for every
 * case that is actually catchable in either language; the PHP shutdown
 * function only covers the narrower case of PHP itself fataling uncatchably
 * (e.g. an OOM kill), which has no faithful Node equivalent.
 */

// ---------------------------------------------------------------------------
// Quiesce modes
// ---------------------------------------------------------------------------

export const QUIESCE_NONE = 'none' as const;
export const QUIESCE_PAUSE = 'pause' as const;
export const QUIESCE_STOP = 'stop' as const;

export type QuiesceMode = typeof QUIESCE_NONE | typeof QUIESCE_PAUSE | typeof QUIESCE_STOP;

/**
 * Docker's own stop timeout defaults to 10 seconds, which is not enough for a
 * database to checkpoint and close. The SIGKILL that follows would leave the
 * files in the same crash state stopping was meant to avoid. Intentionally
 * different from `ContainerService`'s 10-second `STOP_TIMEOUT_SECONDS` — that
 * one is a user clicking Stop; this one is a backup that must not corrupt
 * what it is backing up.
 */
export const QUIESCE_STOP_TIMEOUT_SECONDS = 30;

/**
 * Coerce a stored or request-supplied value to one of the three known modes.
 *
 * Takes `unknown` on purpose: the PHP test suite passes `null` and `['pause']`
 * through the equivalent PHP function, and both must fail closed to "none"
 * rather than throw. Failing closed here means "do not touch the container",
 * matching the pre-quiesce behavior, rather than a mid-run error.
 */
export function quiesceModeFor(value: unknown): QuiesceMode {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return mode === QUIESCE_PAUSE || mode === QUIESCE_STOP ? mode : QUIESCE_NONE;
}

// ---------------------------------------------------------------------------
// Mount mapping (container path -> host path)
// ---------------------------------------------------------------------------

/** The slice of a Docker inspect `Mounts` entry this file reads. */
export interface DockerMount {
    Source?: string;
    Destination?: string;
}

export interface MappedContainerPath {
    mountDestination: string;
    mountSource: string;
    /** The part of the container path below the mount. Empty for a whole mount. */
    relative: string;
    hostPath: string;
}

/**
 * Map a path inside a container onto its path on the host.
 *
 * Picks the longest matching mount `Destination`, so a nested mount wins over
 * a parent that also covers the path. Returns null when no mount covers the
 * path, or when the part below the mount climbs back out with `..`.
 *
 * Pure, and exported standalone (not a class method) so both the backup
 * runner and a future paths endpoint can use it, and so it is testable
 * without a Docker socket — mirrors `BackupManager::mapContainerPath` being
 * `public static` for the same reason.
 *
 * Deliberately NOT built on `pathIsWithin`. `containerPath` is not a
 * filesystem path being checked against a base directory; it is a string
 * being matched against Docker's own mount table to find which mount, if
 * any, a container-side path falls under. `pathIsWithin` normalizes both
 * sides first, which here would change the answer: `/data/../config/foo`
 * would collapse to `/config/foo` and match, where PHP (and this port)
 * reject it outright because the raw string does not start with a mount
 * destination. The actual filesystem safety boundary is the mount's `Source`
 * on the host side, and that IS checked with `pathIsWithin(hostPath, src)`,
 * by the caller, once this function has resolved a host path.
 */
export function mapContainerPath(
    containerPath: string,
    mounts: readonly DockerMount[]
): MappedContainerPath | null {
    let best: MappedContainerPath | null = null;
    let bestLength = -1;

    for (const mount of mounts) {
        const dest = (mount.Destination ?? '').replace(/\/+$/, '');
        const src = (mount.Source ?? '').replace(/\/+$/, '');

        if (dest === '' || src === '' || dest.length <= bestLength) continue;

        let relative: string;
        if (containerPath === dest || containerPath === `${dest}/`) {
            relative = '';
        } else if (containerPath.startsWith(`${dest}/`)) {
            relative = containerPath.slice(dest.length + 1);
        } else {
            continue;
        }

        // The relative part is user-influenced (it comes from a backup
        // pattern) and would otherwise walk out of the mount source. It is
        // never normalized on its own here, only rejected outright.
        if (relative !== '' && relative.split('/').includes('..')) continue;

        bestLength = dest.length;
        best = {
            mountDestination: dest,
            mountSource: src,
            relative,
            hostPath: relative === '' ? src : `${src}/${relative}`,
        };
    }

    return best;
}

// ---------------------------------------------------------------------------
// SQLite sidecar detection
// ---------------------------------------------------------------------------

/** The first 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** True when the file starts with the SQLite header. */
export function isSqliteFile(path: string): boolean {
    let stat;
    try {
        stat = statSync(path);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;

    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        const header = Buffer.alloc(SQLITE_MAGIC.length);
        const bytesRead = readSync(fd, header, 0, header.length, 0);
        return bytesRead === header.length && header.equals(SQLITE_MAGIC);
    } catch {
        return false;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

/** The write-ahead log and journal files that sit beside a database file. */
export function sidecarsFor(path: string): string[] {
    const found: string[] = [];
    for (const suffix of SIDECAR_SUFFIXES) {
        const candidate = `${path}${suffix}`;
        try {
            if (statSync(candidate).isFile()) found.push(candidate);
        } catch {
            // Does not exist; not a sidecar.
        }
    }
    return found;
}

/**
 * Add the sidecar files of every database file in the list.
 *
 * A directory is archived whole, so tar already walks its sidecars. A single
 * file is not: a pattern such as `/config/*.db` matches `app.db` and leaves
 * `app.db-wal` behind. That copy is missing every committed transaction still
 * in the write-ahead log, which is the usual way a restored database turns
 * out broken.
 */
function withSidecars(paths: string[]): string[] {
    const expanded: string[] = [];

    for (const path of paths) {
        expanded.push(path);

        let isDirectory = false;
        try {
            isDirectory = statSync(path).isDirectory();
        } catch {
            // Missing entirely; isSqliteFile() below answers false too, same
            // net effect (skip it) as the PHP is_dir()-then-isSqliteFile() pair.
        }
        if (isDirectory || !isSqliteFile(path)) continue;

        expanded.push(...sidecarsFor(path));
    }

    return Array.from(new Set(expanded));
}

// ---------------------------------------------------------------------------
// tar execution
// ---------------------------------------------------------------------------

export interface ArchiveOutcome {
    success: boolean;
    /** tar's own last few lines of combined stdout+stderr. */
    output: string;
}

/**
 * Runs one `tar` invocation. Narrow and injected (like `ContainerService`
 * takes a `DockerClient`) so tests can fake it without a real archiver.
 */
export interface TarRunner {
    createArchive(archivePath: string, hostPaths: string[]): Promise<ArchiveOutcome>;
}

export const TAR_RUNNER_TOKEN = 'DOCKER_FOLDERS_TAR_RUNNER';

/** How much of tar's combined output is kept while it is still running. */
const OUTPUT_TAIL_CAP = 8000;

/** Last `count` non-empty-tail lines of `text`, joined the way the PHP side reports them. */
function tailLines(text: string, count: number): string {
    if (text === '') return '';
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-count).join('; ');
}

/**
 * The real `tar` runner.
 *
 * `spawn` with an argv array, not `exec`/`execFile` with a joined string and
 * not `{ shell: true }`. Every host path this receives is either a Docker
 * mount `Source` or a path already checked with `pathIsWithin` against that
 * source (see `resolveHostPathsForContainer`); an argv array means those
 * strings reach the `tar` process as literal arguments no matter what
 * characters they contain, so there is nothing for a shell to reinterpret.
 *
 * `execFile`'s `maxBuffer` was considered and rejected: it kills the child
 * outright once combined stdout+stderr crosses the limit, which turns a
 * chatty-but-successful tar run (many "file changed as we read it" warnings)
 * into a false failure with no exit code. `spawn` plus a manually-capped
 * rolling tail avoids that: the archive keeps writing regardless of how much
 * tar has to say about it, and only the last `OUTPUT_TAIL_CAP` characters of
 * chatter are ever held in memory.
 *
 * Never rejects. `runArchiveJob`'s `withQuiesce` wraps this in a `finally`
 * that restores the container regardless of how the work callback settles,
 * but a rejection would still skip `runArchiveJob`'s own
 * `{ success: false, failure: 'archive' }` shaping downstream, so every
 * failure path here resolves instead.
 */
export function createTarRunner(): TarRunner {
    return {
        createArchive(archivePath, hostPaths) {
            return new Promise((resolve) => {
                let tail = '';
                let settled = false;

                const append = (chunk: Buffer) => {
                    tail += chunk.toString('utf8');
                    if (tail.length > OUTPUT_TAIL_CAP) tail = tail.slice(-OUTPUT_TAIL_CAP);
                };

                const finish = (success: boolean) => {
                    if (settled) return;
                    settled = true;
                    resolve({ success, output: tailLines(tail, 3) });
                };

                try {
                    const child = spawn('tar', ['czf', archivePath, ...hostPaths], {
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                    child.stdout?.on('data', append);
                    child.stderr?.on('data', append);
                    child.on('error', (error) => {
                        append(Buffer.from(String(error.message ?? error)));
                        finish(false);
                    });
                    child.on('close', (code) => finish(code === 0));
                } catch (error) {
                    resolve({ success: false, output: String((error as Error)?.message ?? error) });
                }
            });
        },
    };
}

// ---------------------------------------------------------------------------
// Docker access for quiesce
// ---------------------------------------------------------------------------

interface BackupInspectInfo {
    Mounts?: DockerMount[];
    State?: { Running?: boolean; Paused?: boolean };
}

/**
 * Narrow Docker surface this service needs: mount/state inspection plus
 * pause/unpause/start/stop. Deliberately its own interface rather than
 * `containers/docker-client.ts`'s `DockerClient` — that one's
 * `DockerContainerHandle` has no `pause()` and its `DockerInspectInfo` does
 * not carry `Mounts` or `State.Running`, because `ContainerService` never
 * needed either. Widening that shared interface for this one caller was
 * rejected in favor of a second narrow one, matching how `ContainerService`
 * itself takes a narrow interface rather than the whole of dockerode.
 */
export interface BackupContainerHandle {
    inspect(): Promise<BackupInspectInfo>;
    start(): Promise<unknown>;
    stop(options: { t: number }): Promise<unknown>;
    pause(): Promise<unknown>;
    unpause(): Promise<unknown>;
}

/** The slice of `GET /containers/json` this service reads. */
export interface BackupListedContainer {
    Id: string;
    Names?: string[];
    Labels?: Record<string, string> | null;
}

export interface BackupDockerClient {
    listContainers(options: { all: boolean }): Promise<BackupListedContainer[]>;
    getContainer(id: string): BackupContainerHandle;
}

export const BACKUP_DOCKER_CLIENT_TOKEN = 'DOCKER_FOLDERS_BACKUP_DOCKER_CLIENT';

/** Same socket, same construction pattern as `containers/docker-client.ts`. */
export function createBackupDockerClient(): BackupDockerClient {
    // Annotated, not cast, so this assignment keeps checking that the
    // interface above still describes what dockerode actually returns.
    const client: BackupDockerClient = new Dockerode({ socketPath: DOCKER_SOCKET_PATH });
    return client;
}

/**
 * Docker answers "already in that state" with 304; PHP's `DockerClient::request()`
 * treats any 304 as success for every action that goes through it, not only
 * `startContainer` — pause, unpause, and stop all inherit that from the one
 * shared `request()` method. dockerode raises 304 as an error instead, so
 * every action below has to unwrap it the same way. Duplicated from
 * `container.service.ts`'s identical private helper rather than imported: it
 * is not exported there, and exporting it purely for this one caller would
 * widen that file's surface for a single three-line function.
 */
function isNotModified(error: unknown): boolean {
    return (error as { statusCode?: number } | null)?.statusCode === 304;
}

// ---------------------------------------------------------------------------
// Backup roots, destination, retention
// ---------------------------------------------------------------------------

export const BACKUP_ALLOWED_ROOTS_TOKEN = 'DOCKER_FOLDERS_BACKUP_ALLOWED_ROOTS';

/**
 * Matches `BACKUP_ALLOWED_ROOTS` in `include/config.php`. `settings.service.ts`
 * keeps its own identical copy for the same reason this file does: there is
 * no shared config module yet for either to import from. If either list
 * changes, the other and `config.php` must change with it.
 */
export const DEFAULT_BACKUP_ALLOWED_ROOTS: readonly string[] = ['/mnt', '/boot/config/plugins'];

const DEFAULT_BACKUP_DESTINATION = '/mnt/user/backups/docker-folders';
const DEFAULT_RETENTION_COUNT = 7;

/** Strip every trailing slash, the way PHP's `rtrim($path, '/')` calls here do. */
function stripTrailingSlashes(path: string): string {
    return path.replace(/\/+$/, '');
}

function stripLeadingSlash(name: string): string {
    return name.replace(/^\//, '');
}

/**
 * Mirrors PHP's `!$dest`. PHP's loose falsiness treats `null`, `''`, and the
 * string `'0'` alike, and `resolveDestination`'s `if (!$dest)` relies on
 * that. JavaScript's `!value` does not treat `'0'` as falsy, so this is
 * spelled out rather than left implicit.
 */
function isUnsetLikePhp(value: string | null | undefined): boolean {
    return value === null || value === undefined || value === '' || value === '0';
}

function safeGlob(pattern: string): string[] {
    try {
        return globSync(pattern);
    } catch {
        // PHP's glob() answers false on a pattern error rather than throwing;
        // every caller here already treats an empty array as "no matches".
        return [];
    }
}

function statOrNull(path: string) {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export interface BackupResult {
    success: boolean;
    message: string;
    backupFile?: string;
    backupSize?: number;
}

export interface ServiceBackupConfig {
    service: string;
    patterns: string[];
}

export interface BackupFileInfo {
    path: string;
    filename: string;
    size: number;
    createdAt: number;
}

interface ArchiveJobResult {
    success: boolean;
    failure: '' | 'quiesce' | 'archive';
    detail: string;
    note: string;
    restoreError: string;
}

interface QuiesceOutcome<T> {
    ok: boolean;
    message?: string;
    note: string;
    restoreError: string;
    result: T | null;
}

type RunState = 'running' | 'paused' | 'exited' | 'unknown';

/**
 * The backup read and write path, ported from `BackupManager.php`.
 *
 * No resolver on top of this yet; the scheduler and its GraphQL surface are
 * decided elsewhere. This service is the mutation surface that scheduler will
 * call directly.
 */
@Injectable()
export class BackupService {
    constructor(
        private readonly db: DatabaseService,
        @Inject(BACKUP_DOCKER_CLIENT_TOKEN) private readonly docker: BackupDockerClient,
        @Optional()
        @Inject(TAR_RUNNER_TOKEN)
        private readonly tar: TarRunner = createTarRunner(),
        @Optional()
        @Inject(BACKUP_ALLOWED_ROOTS_TOKEN)
        private readonly allowedRoots: readonly string[] = DEFAULT_BACKUP_ALLOWED_ROOTS
    ) {}

    /**
     * Archive one container's matched paths, quiescing it first if asked.
     */
    async backupContainer(
        containerName: string,
        patterns: string[],
        destination: string | null = null,
        retention: number | null = null,
        quiesce: unknown = QUIESCE_NONE
    ): Promise<BackupResult> {
        const resolvedDestination = this.resolveDestination(destination);
        const resolvedRetention = this.resolveRetention(retention);
        const mode = quiesceModeFor(quiesce);

        if (!this.ensureDirectory(resolvedDestination)) {
            return { success: false, message: `Cannot create backup directory: ${resolvedDestination}` };
        }

        // The container itself, not just its paths: withQuiesce() needs the id.
        const container = await this.findContainer(containerName);
        if (!container) {
            return { success: false, message: `Container '${containerName}' not found` };
        }

        const hostPaths = await this.resolveHostPathsForContainer(container.id, patterns);
        if (hostPaths.length === 0) {
            return {
                success: false,
                message: `No matching paths found for container '${containerName}'`,
            };
        }

        const archiveName = generateArchiveName(containerName);
        const archivePath = `${stripTrailingSlashes(resolvedDestination)}/${archiveName}`;

        const job = await this.runArchiveJob(container.id, mode, archivePath, hostPaths);

        if (!job.success) {
            const failed =
                job.failure === 'quiesce' ? job.detail : `Failed to create archive: ${archiveName}${job.detail}`;
            return {
                success: false,
                message: job.restoreError !== '' ? `${failed}. ${job.restoreError}` : failed,
            };
        }

        const size = statOrNull(archivePath)?.size ?? 0;
        const pruned = this.pruneOldBackups(resolvedDestination, containerName, resolvedRetention);
        const message =
            `Backup created: ${archiveName}${job.note}` + (pruned ? `, pruned ${pruned} old backup(s)` : '');

        // A container left frozen is worse than a missing backup, so this
        // reports as a failure even though the archive is on disk. The runner
        // is expected to turn a failure like this into a warning notification.
        if (job.restoreError !== '') {
            return {
                success: false,
                message: `${message}. ${job.restoreError}`,
                backupFile: archivePath,
                backupSize: size,
            };
        }

        return { success: true, message, backupFile: archivePath, backupSize: size };
    }

    /**
     * Archive each configured service of a compose stack, one at a time.
     *
     * Quiets each service around its own archive, not the whole stack around
     * all of them — one service at a time is far less downtime.
     */
    async backupStack(
        projectName: string,
        serviceConfigs: ServiceBackupConfig[],
        destination: string | null = null,
        retention: number | null = null,
        quiesce: unknown = QUIESCE_NONE
    ): Promise<BackupResult> {
        const resolvedDestination = this.resolveDestination(destination);
        const resolvedRetention = this.resolveRetention(retention);
        const mode = quiesceModeFor(quiesce);

        if (!this.ensureDirectory(resolvedDestination)) {
            return { success: false, message: `Cannot create backup directory: ${resolvedDestination}` };
        }

        const containers = await this.docker.listContainers({ all: true });
        const stackContainers = new Map<string, BackupListedContainer>();
        for (const c of containers) {
            const project = c.Labels?.['com.docker.compose.project'];
            if (project !== projectName) continue;
            const service = c.Labels?.['com.docker.compose.service'] ?? stripLeadingSlash(c.Names?.[0] ?? '');
            stackContainers.set(service, c);
        }

        if (stackContainers.size === 0) {
            return { success: false, message: `No containers found for stack '${projectName}'` };
        }

        const results: string[] = [];
        let allSuccess = true;
        // Every path that archives nothing is a failure, the same as in
        // `backupContainer()` (BackupManager.php:143-206). Before, a
        // malformed entry, or one whose service had no matching paths, was
        // skipped in silence, so a config where nothing was actually valid
        // still reported success.
        let archived = 0;
        // The path of the last archive THIS RUN wrote, not a directory scan.
        // Ported from 35cebcb (reported to the dev branch), which replaced an
        // `archivesFor(..., ARCHIVES_STACK)` scan taken after the loop: a run
        // that wrote nothing still reported an old archive and its size, and
        // the stack-scope pattern also matches another stack whose name
        // starts with this one and a dot, e.g. "blog.v2" for "blog".
        let lastArchive = '';

        for (const config of serviceConfigs) {
            const service = config.service;
            const patterns = config.patterns ?? [];

            if (!service || patterns.length === 0) {
                results.push('Skipped a service entry with no service name or no paths');
                allSuccess = false;
                continue;
            }

            const container = stackContainers.get(service);
            if (!container) {
                results.push(`Service '${service}' not found in stack`);
                allSuccess = false;
                continue;
            }

            const hostPaths = await this.resolveHostPathsForContainer(container.Id, patterns);
            if (hostPaths.length === 0) {
                results.push(`No matching paths for service '${service}'`);
                allSuccess = false;
                continue;
            }

            const prefix = `${projectName}.${service}`;
            const archiveName = generateArchiveName(prefix);
            const archivePath = `${stripTrailingSlashes(resolvedDestination)}/${archiveName}`;

            const job = await this.runArchiveJob(container.Id, mode, archivePath, hostPaths);

            if (!job.success) {
                results.push(
                    job.failure === 'quiesce'
                        ? `Service '${service}': ${job.detail}`
                        : `Failed to create archive for service '${service}'${job.detail}`
                );
                if (job.restoreError !== '') {
                    results.push(`Service '${service}': ${job.restoreError}`);
                }
                allSuccess = false;
                continue;
            }

            if (job.restoreError !== '') {
                results.push(`Service '${service}': ${job.restoreError}`);
                allSuccess = false;
            }

            this.pruneOldBackups(resolvedDestination, prefix, resolvedRetention);
            results.push(`Backed up service '${service}': ${archiveName}${job.note}`);
            archived++;
            lastArchive = archivePath;
        }

        // BackupManager.php:201-206: a stack backup with no valid entries at
        // all — an empty `serviceConfigs`, or one where every entry was
        // skipped or failed — is always a failure, and gets its own message
        // only when nothing else already explains why.
        if (archived === 0) {
            allSuccess = false;
            if (results.length === 0) {
                results.push(`No services configured for stack '${projectName}'`);
            }
        }

        const lastArchiveStat = lastArchive !== '' ? statOrNull(lastArchive) : null;
        const size = lastArchiveStat?.isFile() ? lastArchiveStat.size : 0;

        return {
            success: allSuccess,
            message: results.join('; '),
            backupFile: lastArchive,
            backupSize: size,
        };
    }

    /**
     * Archives already on disk for one container or stack prefix, newest first.
     *
     * `targetType` is accepted but unused — ported as-is from
     * `BackupManager::listBackups($targetType, $targetId)`, where the PHP body
     * never reads `$targetType` either. Kept for signature parity with the
     * method it mirrors; see the port's handoff report.
     */
    listBackups(targetType: string, targetId: string): BackupFileInfo[] {
        const destination = this.resolveDestination(null);
        const destStat = statOrNull(destination);
        if (!destStat?.isDirectory()) return [];

        // Ported from badc832 (reported to the dev branch): the stack scope
        // for a stack, the exact scope for a container. `archivesFor()` reads
        // the directory with `readdirSync`, not a glob, so `targetId` cannot
        // widen the match to a sibling directory or list anything outside
        // `destination`, and it excludes symlinks.
        const scope = targetType === 'stack' ? 'services' : 'exact';
        const files = archivesFor(destination, targetId, scope);
        if (files.length === 0) return [];

        return files.map((file) => {
            const stat = statOrNull(file);
            return {
                path: file,
                filename: basename(file),
                size: stat?.size ?? 0,
                createdAt: Math.floor((stat?.mtimeMs ?? 0) / 1000),
            };
        });
    }

    /**
     * Delete one archive file, refusing anything that is not an archive this
     * service wrote, directly in the backup destination.
     *
     * Resolves both sides with `realpathSync` first, mirroring PHP's
     * `realpath()` pair. `paths.ts`'s `pathIsWithin` is deliberately
     * lexical-only (it must accept a write target that does not exist yet
     * elsewhere in this codebase), so resolving with the filesystem here is
     * what catches a symlink planted inside the destination that points
     * outside it.
     *
     * Containment alone is not enough: the destination
     * can be an allowed root itself (e.g. `/mnt`), or a broad one
     * (`/mnt/user`), and then "inside the destination" means every file on
     * the array. Ported from b97b7e3 (reported to the dev branch):
     * `dirname(realpath(file))` must equal `realpath(destination)` exactly —
     * the file must sit directly in the destination, not in a
     * subdirectory — plus the file must be named like an archive
     * `generateArchiveName` writes (`isArchiveName`).
     *
     * The resolved path (`realFile`), not the original `filePath`, is used
     * for the final existence check and the unlink — a symlink at `filePath`
     * that resolved to an in-destination archive should delete that archive,
     * not the link (and by this point `dirname(realFile) === realDest` has
     * already ruled out a symlink pointing anywhere else).
     */
    deleteBackup(filePath: string): boolean {
        const destination = this.resolveDestination(null);

        let realDest: string;
        let realFile: string;
        try {
            realDest = realpathSync(destination);
            realFile = realpathSync(filePath);
        } catch {
            return false;
        }

        // pathIsWithin also fails closed on a weak destination such as "/",
        // which the dirname comparison alone would accept (539fa7f on dev).
        if (
            !pathIsWithin(realFile, realDest) ||
            dirname(realFile) !== realDest ||
            !isArchiveName(basename(realFile))
        ) {
            return false;
        }

        try {
            if (existsSync(realFile) && statSync(realFile).isFile()) {
                unlinkSync(realFile);
                return true;
            }
        } catch {
            return false;
        }
        return false;
    }

    /** Public helper: host paths a set of patterns resolves to for a named container. */
    async resolveHostPaths(containerName: string, patterns: string[]): Promise<string[]> {
        const container = await this.findContainer(containerName);
        return container ? this.resolveHostPathsForContainer(container.id, patterns) : [];
    }

    // -----------------------------------------------------------------------
    // Destination / retention / directory
    // -----------------------------------------------------------------------

    private resolveDestination(override: string | null): string {
        let dest = override;
        if (isUnsetLikePhp(dest)) {
            const rows = this.db.query("SELECT value FROM settings WHERE key = 'backup_destination'");
            dest = rows[0] ? String(rows[0].value) : DEFAULT_BACKUP_DESTINATION;
        }

        // Block writing outside safe base paths. Normalize first: a raw
        // prefix test accepts "/mnt/../etc", which collapses to somewhere
        // else entirely.
        const normalized = normalizePath(dest);
        if (normalized === null || !pathIsWithinAny(normalized, this.allowedRoots)) {
            throw new BadRequestException(
                'Backup destination must be under /mnt/ or /boot/config/plugins/'
            );
        }

        return normalized;
    }

    private resolveRetention(override: number | null): number {
        if (override !== null && override !== undefined) {
            return Math.max(1, Math.trunc(override));
        }

        const rows = this.db.query("SELECT value FROM settings WHERE key = 'default_retention_count'");
        if (rows[0]) {
            const parsed = Number.parseInt(String(rows[0].value), 10);
            return Math.max(1, Number.isNaN(parsed) ? 0 : parsed);
        }
        return DEFAULT_RETENTION_COUNT;
    }

    private ensureDirectory(path: string): boolean {
        const stat = statOrNull(path);
        if (stat?.isDirectory()) return true;
        try {
            mkdirSync(path, { recursive: true, mode: 0o755 });
            return true;
        } catch {
            return false;
        }
    }

    // -----------------------------------------------------------------------
    // Container lookup / mount resolution
    // -----------------------------------------------------------------------

    private async findContainer(containerName: string): Promise<{ id: string; name: string } | null> {
        const list = await this.docker.listContainers({ all: true });
        for (const c of list) {
            const name = stripLeadingSlash(c.Names?.[0] ?? '');
            if (name === containerName) return { id: c.Id, name };
        }
        return null;
    }

    private async resolveHostPathsForContainer(containerId: string, patterns: string[]): Promise<string[]> {
        let detail: BackupInspectInfo;
        try {
            detail = await this.docker.getContainer(containerId).inspect();
        } catch {
            return [];
        }

        const mounts = detail.Mounts ?? [];
        const hostPaths: string[] = [];

        for (const pattern of patterns) {
            const mapped = mapContainerPath(pattern, mounts);
            if (mapped === null) continue;

            const src = mapped.mountSource;
            const hostPath = mapped.hostPath;

            // The whole mount. tar walks it, so there is nothing more to resolve.
            if (mapped.relative === '') {
                hostPaths.push(src);
                continue;
            }

            if (mapped.relative.includes('*') || mapped.relative.includes('?')) {
                for (const match of safeGlob(hostPath)) {
                    if (pathIsWithin(match, src)) hostPaths.push(match);
                }
                continue;
            }

            if (pathIsWithin(hostPath, src) && existsSync(hostPath)) {
                hostPaths.push(hostPath);
            }
        }

        return withSidecars(Array.from(new Set(hostPaths)));
    }

    // -----------------------------------------------------------------------
    // Archive job: quiesce, archive, restore
    // -----------------------------------------------------------------------

    /**
     * Write one archive with the container quieted, and say what happened.
     *
     * `success` means the archive reached disk. On a failure, `failure` names
     * the step that failed, either `'quiesce'` or `'archive'`, and `detail`
     * holds the words that step produced. `note` and `restoreError` come
     * straight from `withQuiesce`.
     */
    private async runArchiveJob(
        containerId: string,
        quiesce: QuiesceMode,
        archivePath: string,
        hostPaths: string[]
    ): Promise<ArchiveJobResult> {
        const run = await this.withQuiesce(containerId, quiesce, () =>
            this.tar.createArchive(archivePath, hostPaths)
        );

        if (!run.ok) {
            return { success: false, failure: 'quiesce', detail: run.message ?? '', note: '', restoreError: '' };
        }

        const archive = run.result as ArchiveOutcome;
        if (!archive.success) {
            // Carries the restore error through, which the PHP drops
            // (BackupManager.php:504-508, reported to the dev branch). When
            // the archive fails and the container also could not be started
            // again, the container being left down is the more important of
            // the two, and it is the part nobody would otherwise hear about.
            return {
                success: false,
                failure: 'archive',
                detail: archive.output !== '' ? `: ${archive.output}` : '',
                note: '',
                restoreError: run.restoreError,
            };
        }

        return { success: true, failure: '', detail: '', note: run.note, restoreError: run.restoreError };
    }

    /**
     * Run `work` with the container paused or stopped, then put it back.
     *
     * Returns `{ ok: false }` when the container could not be quieted, and
     * `work` never runs. Otherwise `result` holds what `work` returned,
     * `note` is text for the success message, and `restoreError` is
     * non-empty when the container could not be started or resumed
     * afterward.
     *
     * The restore runs in a `finally`, so it happens whether `work` resolves,
     * resolves with a failure payload (tar's own non-zero exit does not
     * throw), or throws. A container left frozen because a backup failed is
     * the worse outcome this whole mode exists to prevent.
     */
    private async withQuiesce<T>(
        containerId: string,
        mode: QuiesceMode,
        work: () => Promise<T>
    ): Promise<QuiesceOutcome<T>> {
        if (mode !== QUIESCE_PAUSE && mode !== QUIESCE_STOP) {
            return { ok: true, note: '', restoreError: '', result: await work() };
        }

        const state = await this.containerRunState(containerId);

        // A stopped container is already as quiet as it gets, and starting it
        // afterward would be a state change nobody asked for. A container
        // someone else paused is left paused for the same reason.
        if (state === 'exited' || state === 'paused') {
            return { ok: true, note: '', restoreError: '', result: await work() };
        }

        // Inspect failed, so the state is unknown. Running the archive anyway
        // is the silent downgrade this mode exists to prevent.
        if (state !== 'running') {
            return {
                ok: false,
                message: 'Could not read the container state before the backup',
                note: '',
                restoreError: '',
                result: null,
            };
        }

        const container = this.docker.getContainer(containerId);
        const quieted =
            mode === QUIESCE_PAUSE
                ? await this.dockerAction(() => container.pause())
                : await this.dockerAction(() => container.stop({ t: QUIESCE_STOP_TIMEOUT_SECONDS }));

        // Never fall back to an unquiet backup. The caller picked this mode to
        // protect a database, and a silent downgrade hands back an archive
        // believed to be safe when it is not.
        if (!quieted) {
            return {
                ok: false,
                message: `Could not ${mode} the container before the backup`,
                note: '',
                restoreError: '',
                result: null,
            };
        }

        let result: T;
        let restored = false;
        try {
            result = await work();
        } finally {
            restored = await this.restoreContainer(containerId, mode);
        }

        if (!restored) {
            const verb = mode === QUIESCE_PAUSE ? 'resumed' : 'started';
            return {
                ok: true,
                note: '',
                restoreError: `The container could not be ${verb} again after the backup`,
                result,
            };
        }

        const note =
            mode === QUIESCE_PAUSE ? ' (container paused during backup)' : ' (container stopped during backup)';
        return { ok: true, note, restoreError: '', result };
    }

    private async containerRunState(containerId: string): Promise<RunState> {
        let raw: BackupInspectInfo;
        try {
            raw = await this.docker.getContainer(containerId).inspect();
        } catch {
            return 'unknown';
        }

        const state = raw.State;
        if (!state) return 'unknown';
        if (state.Paused) return 'paused';
        return state.Running ? 'running' : 'exited';
    }

    private async restoreContainer(containerId: string, mode: QuiesceMode): Promise<boolean> {
        const container = this.docker.getContainer(containerId);

        if (mode === QUIESCE_PAUSE) {
            return this.dockerAction(() => container.unpause());
        }

        // Mirrors DockerClient::startContainer exactly: Docker answers /start
        // on a paused container with 304 and leaves it paused, so a paused
        // container is resumed instead of started. Reproduced here (rather
        // than relied on implicitly) so a stop-mode restore is safe even if
        // something else paused the container mid-backup. PHP proceeds to
        // /start even when this inspect itself fails; matched by treating an
        // inspect failure as "not paused" rather than bailing out.
        let paused = false;
        try {
            const info = await container.inspect();
            paused = info.State?.Paused === true;
        } catch {
            paused = false;
        }

        return paused
            ? this.dockerAction(() => container.unpause())
            : this.dockerAction(() => container.start());
    }

    /**
     * Run one Docker action, treating a 304 the same way PHP's shared
     * `request()` does: as success, not failure. Swallows every other error
     * and answers false, matching the bool-returning PHP methods this stands
     * in for — callers here decide what a false means, none of them expect an
     * exception out of a pause/stop/start/unpause call.
     */
    private async dockerAction(action: () => Promise<unknown>): Promise<boolean> {
        try {
            await action();
            return true;
        } catch (error) {
            return isNotModified(error);
        }
    }

    // -----------------------------------------------------------------------
    // Pruning
    // -----------------------------------------------------------------------

    private pruneOldBackups(destination: string, prefix: string, retention: number): number {
        // Exactly the archives this prefix wrote. Ported from 39c1091
        // (reported to the dev branch): a glob of `<prefix>.*.tar.gz` also
        // matched other targets, e.g. a container named "blog" pruned the
        // "blog.web.<stamp>" archives of a stack named "blog". `archivesFor()`
        // reads the directory with `readdirSync`, so unlike the old glob-based
        // version there is no per-file containment recheck needed here: a
        // glob metacharacter in `destination` cannot widen a directory
        // listing the way it could a glob pattern.
        const files = archivesFor(destination, prefix, 'exact');

        if (files.length <= retention) return 0;

        let deleted = 0;
        for (const file of files.slice(retention)) {
            try {
                unlinkSync(file);
                deleted++;
            } catch {
                // Leave it; matches PHP's unlink() returning false without
                // throwing.
            }
        }

        return deleted;
    }
}

// ---------------------------------------------------------------------------
// Archive naming
// ---------------------------------------------------------------------------

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * Local time, matching PHP's `date('Y-m-d_His')`, which runs against
 * whatever timezone `date_default_timezone_set()` configured for the
 * process — the same reasoning `schedules/cron.ts` documents for its own use
 * of local `Date` getters over UTC ones.
 */
/** The stamp `formatLocalTimestamp` writes: `2026-09-21_031500`. */
const ARCHIVE_STAMP = String.raw`\d{4}-\d{2}-\d{2}_\d{6}`;

/** One sanitized name segment, as `sanitizeArchivePrefix` produces them. */
const ARCHIVE_SEGMENT = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*`;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is this file an archive this service wrote for `prefix`?
 *
 * `exact` is `<prefix>.<stamp>.tar.gz`, a container's or one stack service's.
 * `services` is `<prefix>.<service>.<stamp>.tar.gz`, every service of a stack.
 */
function isArchiveOf(file: string, prefix: string, kind: 'exact' | 'services'): boolean {
    const middle = kind === 'services' ? String.raw`\.${ARCHIVE_SEGMENT}` : '';
    return new RegExp(`^${escapeRegex(prefix)}${middle}\\.${ARCHIVE_STAMP}\\.tar\\.gz$`).test(basename(file));
}

/** Named like any archive this service writes. */
export function isArchiveName(name: string): boolean {
    return new RegExp(`^${ARCHIVE_SEGMENT}\\.${ARCHIVE_STAMP}\\.tar\\.gz$`).test(name);
}

/** Byte-order comparison, matching PHP's `strcmp()`. */
function strcmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * PHP's usort comparator inside `archivesFor()`: newest first, ties (same
 * whole second) broken by name, descending. `filemtime()` truncates to whole
 * seconds, so the tie-break is reached far more often in PHP than a naive
 * millisecond comparison here would suggest — `Math.trunc(mtimeMs / 1000)`
 * reproduces that truncation rather than comparing at millisecond precision.
 */
function compareArchivesNewestFirst(a: string, b: string): number {
    const secondsOf = (path: string) => Math.trunc((statOrNull(path)?.mtimeMs ?? 0) / 1000);
    const diff = secondsOf(b) - secondsOf(a);
    return diff !== 0 ? diff : strcmp(basename(b), basename(a));
}

/** The names in `dir`, or `[]` if it cannot be read — mirrors PHP's `scandir($dir) ?: []`. */
function readDirectoryNames(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * A regular file, not a symlink — checked with `lstatSync` so a symlink is
 * never followed. `is_file()` in PHP follows symlinks, so PHP additionally
 * checks `!is_link($path)`; `lstatSync(...).isFile()` already answers false
 * for a symlink (lstat reports it as `isSymbolicLink()`, never `isFile()`),
 * so no separate check is needed here.
 */
function isRegularFileNotSymlink(path: string): boolean {
    try {
        return lstatSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * The archives in `dir` that belong to one target, newest first. Ported from
 * `BackupManager::archivesFor` (39c1091/badc832/73807ee, reported to the dev
 * branch).
 *
 * `'exact'` matches `<prefix>.<stamp>.tar.gz` — one container, or one stack
 * service when `prefix` is `"project.service"`. `'services'` (PHP's
 * `ARCHIVES_STACK`) matches `<prefix>.<service>.<stamp>.tar.gz` — every
 * service of the stack named `prefix`.
 *
 * Reads the directory with `readdirSync`, not a glob, so a destination
 * containing a glob metacharacter cannot match a sibling directory — the
 * bug `listBackups`/`pruneOldBackups` used to have. Excludes symlinks with
 * `lstatSync`, which a glob-based listing could not do either.
 *
 * One collision remains that no name rule can separate, matching PHP: a
 * container named "blog.web" and service "web" of a stack named "blog"
 * write the same name.
 */
export function archivesFor(dir: string, prefix: string, scope: 'exact' | 'services' = 'exact'): string[] {
    // Must match generateArchiveName's sanitizer, or this stops finding the
    // archives that were actually written.
    const safePrefix = sanitizeArchivePrefix(prefix);
    if (safePrefix === null || !statOrNull(dir)?.isDirectory()) return [];

    const base = stripTrailingSlashes(dir);

    return readDirectoryNames(base)
        .filter((name) => isArchiveOf(name, safePrefix, scope))
        .map((name) => `${base}/${name}`)
        .filter(isRegularFileNotSymlink)
        .sort(compareArchivesNewestFirst);
}

function formatLocalTimestamp(date: Date): string {
    return (
        `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
        `_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
    );
}

/**
 * `prefix` is a container name, or `"project.service"`. Coerced rather than
 * rejected: `backupStack` loops over services, so throwing here would abort
 * the backups for every remaining service in the stack.
 */
function generateArchiveName(prefix: string): string {
    const safePrefix = sanitizeArchivePrefix(prefix) ?? 'backup';
    return `${safePrefix}.${formatLocalTimestamp(new Date())}.tar.gz`;
}
