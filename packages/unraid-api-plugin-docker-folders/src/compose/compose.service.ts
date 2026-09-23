import {
    accessSync,
    chmodSync,
    constants as fsConstants,
    copyFileSync,
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';
import { Observable, type Subscriber } from 'rxjs';

import type { Row } from '../db/database.service.js';
import { DatabaseService } from '../db/database.service.js';
import { FolderService } from '../folders/folder.service.js';
import { nowSeconds } from '../util/time.js';
import { normalizePath, pathIsWithin, pathIsWithinAny, safePathComponent, safeProjectName } from '../paths/paths.js';
import {
    COMPOSE_PATHS_TOKEN,
    DEFAULT_COMPOSE_PATHS,
    exportAllowedRoots,
    type ComposePathsConfig,
} from './compose-config.js';
import * as composeFiles from './compose-files.js';
import { findComposeFile, parseComposeServiceNames, type StackFileFields } from './compose-files.js';
import {
    COMPOSE_RUNNER_TOKEN,
    type ComposeExecResult,
    type ComposeRunOptions,
    type ComposeRunner,
} from './compose-runner.js';
import type {
    DockerFoldersComposeActionResult,
    DockerFoldersComposeStack,
    DockerFoldersComposeStatus,
    DockerFoldersComposeStreamEvent,
    DockerFoldersComposeValidationError,
} from './compose.model.js';

/** Row shape of `compose_stacks`, as `SELECT *` returns it. */
interface ComposeStackRow extends Row {
    project_name: string;
    working_dir: string | null;
    compose_file: string | null;
    env_file: string | null;
    autostart: number;
    autostart_force_recreate: number;
    description: string | null;
    imported_from: string | null;
    created_at: number;
    updated_at: number;
}

/** One entry of `docker compose ps --format json`. Only `State` is read. */
interface ComposePsEntry {
    State?: string;
    [key: string]: unknown;
}

/**
 * One `compose_plugin` project queued for import, built by
 * `buildComposeImportPlan` and consumed by `commitComposeImportPlan` /
 * `cleanupFailedComposeImport`. `ComposeManager::importFromComposePlugin`'s
 * `$plans[]` entry shape (ComposeManager.php:1609-1619).
 */
interface ComposeImportPlan {
    project: string;
    name: string | null;
    description: string | null;
    autostart: boolean;
    workingDir: string;
    composeFile: string | null;
    envFile: string | null;
    /** Whether THIS run created `workingDir` (vs. it already existing). */
    createdDir: boolean;
    /** Files THIS run copied into `workingDir` that did not already exist there. */
    copied: string[];
}

/**
 * `ComposeManager::createStack`'s placeholder content for a brand new stack
 * (ComposeManager.php:395). Kept byte-for-byte: it is what a user sees the
 * first time they open the editor for a stack they just created.
 */
const DEFAULT_COMPOSE_CONTENT = 'version: "3.8"\nservices:\n  app:\n    image: \n';

/**
 * The project-name rule shared by every Compose HTTP endpoint, ported from
 * `compose.php` and `compose-stream.php` (49a9a1b, then 7ded47c gave
 * `compose.php` the same 128-character cap `compose-stream.php` already had —
 * both reported to the dev branch): one path segment starting with a letter
 * or digit (`safePathComponent`, from `paths.ts`), capped at 128 characters.
 * `safeProjectName` (also in `paths.ts`) is NOT a substitute here — it
 * rejects dots, which this rule and PHP's both allow, because a stack
 * imported from compose.manager keeps its directory name.
 *
 * Exported so `ComposeResolver` can check every `project` argument at the
 * boundary — including, for the streaming subscription, re-checking
 * synchronously in the same order `compose-stream.php` does (project rule
 * before the `management_enabled` gate) without depending on the resolver
 * calling into the service first.
 */
export const PROJECT_NAME_MAX_LENGTH = 128;

export function isValidProjectName(project: string): boolean {
    return safePathComponent(project) !== null && project.length <= PROJECT_NAME_MAX_LENGTH;
}

/**
 * Milliseconds that `up`, `down`, `stop`, and `pull` may run, ported from
 * `ComposeManager::STACK_COMMAND_TIMEOUT` (3b09007, reported to the dev
 * branch). `up -d` pulls any missing image first, which can take minutes on a
 * slow link — the previous 120s default (`stackUp`/`stackDown`/`stackStop`)
 * and 300s (`stackPull`) both killed a legitimately slow run. PHP's own
 * `execCommand` DOES enforce whatever timeout it is given (`ef7ead6`,
 * reported to the dev branch — see `DEFAULT_EXEC_TIMEOUT_MS`'s doc comment in
 * `compose-runner.ts`), so raising this value is what actually stops those
 * commands from being killed early, on both backends. Matches
 * `execCommandStreaming`'s own 600s default, i.e. `DEFAULT_STREAM_TIMEOUT_MS`
 * in `compose-runner.ts`.
 */
const STACK_COMMAND_TIMEOUT_MS = 600_000;

/** How often `ComposeService.logStream` flushes buffered `docker compose logs --follow` lines. */
const LOG_STREAM_COALESCE_MS = 150;

/**
 * The Compose read/write and process-execution path, ported from
 * `ComposeManager.php` (~1640 lines).
 *
 * ARCHITECTURE NOTE — where publishing lives, and why this diverges from
 * `FolderService`/`ContainerService`:
 *
 * Those two publish from inside the service (`FolderService.mutate`,
 * `ContainerService.act`), and that is the right call there because every
 * write to a folder or a container goes through exactly one path: a GraphQL
 * resolver. Compose does not. `ComposeManager.php` never imports
 * `WebSocketPublisher` at all (grep confirms zero references) — every
 * `WebSocketPublisher::publish('compose', ...)` call lives in
 * `api/compose.php`, one layer up, and PHP has a SECOND caller of the
 * manager that bypasses that layer entirely: `startAutostartStacks`/
 * `stopAutostartStacks` (ported below), invoked from an emhttp event hook on
 * Docker start/stop, call `stackUp`/`stackDown` directly and therefore never
 * publish anything. If this service published from inside `stackUp`, wiring
 * that hook later would make autostart announce `compose`/`up` over the
 * websocket for the first time ever — a behavior PHP never had. So, matching
 * PHP's actual layering instead of the other two services' convention: this
 * class never touches `EventBusService`, and `ComposeResolver` publishes,
 * exactly where and exactly when each `api/compose.php` branch does. See the
 * resolver for the full per-action publish/gate table.
 *
 * The one exception is folder creation inside `createStack`, which calls
 * `FolderService.createFolder` directly — manager-to-manager, exactly like
 * `ComposeManager::createStack` requiring `FolderManager.php` — and that
 * publishes `folder`/`create` on its own, because `FolderService` always
 * does, regardless of caller. That is `FolderService`'s existing contract,
 * not something this class opts into.
 */
@Injectable()
export class ComposeService {
    private readonly logger = new Logger(ComposeService.name);

    constructor(
        private readonly db: DatabaseService,
        private readonly folders: FolderService,
        @Inject(COMPOSE_RUNNER_TOKEN) private readonly runner: ComposeRunner,
        @Optional()
        @Inject(COMPOSE_PATHS_TOKEN)
        private readonly paths: ComposePathsConfig = DEFAULT_COMPOSE_PATHS
    ) {}

    // ─── Binary detection & installation ───────────────────────────────

    /** `ComposeManager::isComposeAvailable`. */
    async isComposeAvailable(): Promise<boolean> {
        const result = await this.runner.exec(['compose', 'version']);
        return result.success;
    }

    /** `ComposeManager::getComposeVersion`. */
    async getComposeVersion(): Promise<string | null> {
        const result = await this.runner.exec(['compose', 'version', '--short']);
        if (!result.success || result.stdout.trim() === '') return null;
        return result.stdout.trim().split('\n')[0];
    }

    /**
     * `ComposeManager::installComposeBinary`. Downloads the pinned Compose
     * CLI plugin release over HTTPS and verifies its SHA256 before it is
     * trusted — the download itself is not a shell concern (no argv, no
     * child process), but the binary it produces is later executed by every
     * other method in this class, so the hash check is the security boundary
     * for this one method.
     */
    async installComposeBinary(): Promise<{ success: boolean; error: string | null }> {
        const url = `https://github.com/docker/compose/releases/download/v${this.paths.binaryVersion}/docker-compose-linux-x86_64`;
        const dir = dirname(this.paths.binaryPath);

        if (!existsSync(dir)) {
            try {
                mkdirSync(dir, { recursive: true });
            } catch {
                return { success: false, error: `Failed to create directory: ${dir}` };
            }
        }

        const tmpPath = `${this.paths.binaryPath}.tmp`;

        let response: Response;
        try {
            // 120s matches PHP's CURLOPT_TIMEOUT; PHP separately sets a 10s
            // CURLOPT_CONNECTTIMEOUT, which `fetch` has no equivalent knob
            // for — a single overall timeout is the closest match.
            response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
        } catch (error) {
            return { success: false, error: `Download failed: ${errorMessage(error)}` };
        }

        if (!response.ok || response.body === null) {
            return { success: false, error: `Download failed: HTTP ${response.status}` };
        }

        try {
            await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmpPath));
        } catch (error) {
            safeUnlink(tmpPath);
            return { success: false, error: `Download failed: ${errorMessage(error)}` };
        }

        const hash = await sha256File(tmpPath);
        if (hash !== this.paths.binarySha256) {
            safeUnlink(tmpPath);
            return {
                success: false,
                error: `SHA256 verification failed. Expected: ${this.paths.binarySha256}, got: ${hash}`,
            };
        }

        try {
            renameSync(tmpPath, this.paths.binaryPath);
            chmodSync(this.paths.binaryPath, 0o755);
        } catch {
            safeUnlink(tmpPath);
            return { success: false, error: 'Failed to move binary into place' };
        }

        return { success: true, error: null };
    }

    // ─── Conflict detection ─────────────────────────────────────────────

    /** `ComposeManager::isComposePluginInstalled`. */
    isComposePluginInstalled(): boolean {
        return isDir(this.paths.pluginDir);
    }

    /** `ComposeManager::hasComposePluginData`. */
    hasComposePluginData(): boolean {
        const imported = this.db.read(
            (db) =>
                db
                    .prepare("SELECT COUNT(*) AS cnt FROM compose_stacks WHERE imported_from = 'compose_plugin'")
                    .get() as { cnt: number }
        );
        if (imported && Number(imported.cnt) > 0) return false;

        return this.composePluginHasRealProjects();
    }

    private composePluginHasRealProjects(): boolean {
        let entries: string[];
        try {
            entries = readdirSync(this.paths.pluginProjectsDir);
        } catch {
            return false;
        }

        for (const entry of entries) {
            const projectPath = `${this.paths.pluginProjectsDir}/${entry}`;
            if (!isDir(projectPath)) continue;
            if (
                existsSync(`${projectPath}/name`) ||
                existsSync(`${projectPath}/indirect`) ||
                findComposeFile(projectPath) !== null
            ) {
                return true;
            }
        }
        return false;
    }

    /** `ComposeManager::getStatus`. */
    async getStatus(): Promise<DockerFoldersComposeStatus> {
        const available = await this.isComposeAvailable();
        const pluginInstalled = this.isComposePluginInstalled();

        return {
            composeAvailable: available,
            composeVersion: available ? await this.getComposeVersion() : null,
            composePluginInstalled: pluginInstalled,
            managementEnabled: available && !pluginInstalled,
            composePluginDataExists: this.hasComposePluginData(),
        };
    }

    // ─── Stack CRUD ──────────────────────────────────────────────────────

    /**
     * `ComposeManager::getAllStacks`. For each stack, runs `docker compose
     * ps` to count running services — sequential, matching PHP's
     * synchronous loop (ComposeManager.php:227-248) rather than
     * `Promise.all`. Each iteration spawns two child processes (`stackPs`
     * checks `isComposeAvailable` every time — see `stackPs` below), so a
     * box with many stacks pays for `2N` processes either way; sequential
     * keeps that bounded to one at a time instead of a burst of `2N`
     * concurrent `docker` invocations against a production Docker daemon.
     */
    async getAllStacks(): Promise<DockerFoldersComposeStack[]> {
        const rows = this.db.read(
            (db) => db.prepare('SELECT * FROM compose_stacks ORDER BY project_name ASC').all() as ComposeStackRow[]
        );

        const stacks: DockerFoldersComposeStack[] = [];
        for (const row of rows) {
            const ps = await this.stackPs(row.project_name);
            stacks.push(this.toStackDto(row, ps));
        }
        return stacks;
    }

    /** `ComposeManager::getStack`. */
    async getStack(projectName: string): Promise<DockerFoldersComposeStack | null> {
        const row = this.db.read(
            (db) =>
                db.prepare('SELECT * FROM compose_stacks WHERE project_name = ?').get(projectName) as
                    | ComposeStackRow
                    | undefined
        );
        if (!row) return null;

        const ps = await this.stackPs(projectName);
        return this.toStackDto(row, ps);
    }

    private toStackDto(row: ComposeStackRow, ps: ComposePsEntry[]): DockerFoldersComposeStack {
        return {
            projectName: row.project_name,
            workingDir: row.working_dir,
            composeFile: row.compose_file,
            envFile: row.env_file,
            autostart: Number(row.autostart) === 1,
            autostartForceRecreate: Number(row.autostart_force_recreate) === 1,
            description: row.description,
            importedFrom: row.imported_from,
            servicesTotal: ps.length,
            servicesRunning: ps.filter((service) => service.State === 'running').length,
            // Always included so the UI can render a faded preview even when
            // the stack is fully down (no containers, so `ps` is empty).
            serviceNames: resolveServiceNames(row),
        };
    }

    /**
     * `ComposeManager::createStack`. Project-name validation happens HERE,
     * not at the resolver — matching where `ComposeManager::createStack`
     * itself does it (ComposeManager.php:371), unlike the path-shaped
     * settings this codebase otherwise validates at the boundary. Everything
     * downstream (`stackDir`, the folder lookup) depends on `safeName` being
     * a bare identifier, never on the caller's raw input.
     */
    createStack(
        projectName: string,
        composeContent = '',
        envContent = ''
    ): { success: boolean; error: string | null; projectName: string | null } {
        const safeName = safeProjectName(projectName);
        if (safeName === null) {
            return {
                success: false,
                error: 'Invalid project name. Use only letters, numbers, hyphens, and underscores.',
                projectName: null,
            };
        }

        const existing = this.db.read((db) =>
            db.prepare('SELECT project_name FROM compose_stacks WHERE project_name = ?').get(safeName)
        );
        if (existing) {
            return { success: false, error: `Stack '${safeName}' already exists`, projectName: null };
        }

        const stackDir = `${this.paths.stacksDir}/${safeName}`;
        if (!existsSync(stackDir)) {
            try {
                mkdirSync(stackDir, { recursive: true });
            } catch {
                return { success: false, error: 'Failed to create stack directory', projectName: null };
            }
        }

        const composeFile = `${stackDir}/docker-compose.yml`;
        try {
            writeFileSync(composeFile, composeContent === '' ? DEFAULT_COMPOSE_CONTENT : composeContent, 'utf8');
        } catch {
            return { success: false, error: 'Failed to write compose file', projectName: null };
        }

        let envFile: string | null = null;
        if (envContent !== '') {
            envFile = `${stackDir}/.env`;
            try {
                writeFileSync(envFile, envContent, 'utf8');
            } catch {
                // Best effort, matching PHP's `@file_put_contents` — a failed
                // env write does not fail stack creation.
            }
        }

        const now = nowSeconds();
        this.db.write((db) => {
            db.prepare(
                `INSERT INTO compose_stacks
                    (project_name, working_dir, compose_file, env_file, autostart,
                     autostart_force_recreate, description, imported_from, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?)`
            ).run(safeName, stackDir, composeFile, envFile, now, now);
        });

        // Manager-to-manager, exactly like `ComposeManager::createStack`
        // requiring `FolderManager.php` directly rather than going through
        // an HTTP call. Reused rather than duplicated so a stack created
        // here gets the exact folder shape (icon, position arithmetic) a
        // Compose-label-discovered one gets via `FolderService`'s own ported
        // `upsertComposeStack`, and so it publishes `folder`/`create`
        // through `FolderService`'s existing contract instead of this class
        // reimplementing that plumbing.
        const existingFolder = this.db.read((db) =>
            db.prepare('SELECT id FROM folders WHERE compose_project = ?').get(safeName)
        );
        if (!existingFolder) {
            this.folders.createFolder({ name: safeName, icon: 'layer-group', composeProject: safeName });
        }

        return { success: true, error: null, projectName: safeName };
    }

    /**
     * `ComposeManager::upsertStack` is deliberately NOT ported here. It
     * already exists, ported, as the private `upsertComposeStack` helper in
     * `folders/folder.service.ts`, called from `FolderService.syncWithContainers`
     * on every container-list load — the same call site `containers.php`
     * uses in PHP. Re-implementing it in this file would give the two
     * backends two different code paths writing the same `compose_stacks`
     * columns from the same Docker labels, which is exactly the kind of
     * drift CLAUDE.md's "ported rather than reinvented" reasoning warns
     * about for `FolderService` itself.
     */

    setAutostart(projectName: string, enabled: boolean, forceRecreate = false): void {
        this.db.write((db) => {
            db.prepare(
                'UPDATE compose_stacks SET autostart = ?, autostart_force_recreate = ?, updated_at = ? WHERE project_name = ?'
            ).run(enabled ? 1 : 0, forceRecreate ? 1 : 0, nowSeconds(), projectName);
        });
    }

    /**
     * `ComposeManager::getStackWorkingDir`. Cheaper than `getStack()`, which
     * also shells out to `docker compose ps`.
     */
    getStackWorkingDir(projectName: string): string | null {
        const row = this.db.read(
            (db) =>
                db.prepare('SELECT working_dir FROM compose_stacks WHERE project_name = ?').get(projectName) as
                    | { working_dir: string | null }
                    | undefined
        );
        return row?.working_dir || null;
    }

    /**
     * `ComposeManager::setEnvFilePath`. The caller (the resolver) must pass
     * an already-validated absolute path, or null to fall back to the
     * default `.env` in `working_dir` — validation lives at the HTTP
     * boundary, in `ComposeResolver`, not here. See that class for why:
     * `working_dir` is label-derived and legitimately unbounded, and a
     * containment check inside this method would reject genuine stacks.
     */
    setEnvFilePath(projectName: string, path: string | null): void {
        this.db.write((db) => {
            db.prepare('UPDATE compose_stacks SET env_file = ?, updated_at = ? WHERE project_name = ?').run(
                path,
                nowSeconds(),
                projectName
            );
        });
    }

    /**
     * `ComposeManager::setDescription`. Unlike every other write in this
     * class, PHP's `set_description` branch (`api/compose.php`, no line
     * anchor — it is the last action before the catch-all) checks neither
     * `management_enabled` nor publishes an event. Ported faithfully: a
     * description can be edited even while Compose management is disabled,
     * and doing so is silent to other open tabs. Reported, not fixed.
     */
    setDescription(projectName: string, description: string): void {
        this.db.write((db) => {
            db.prepare('UPDATE compose_stacks SET description = ?, updated_at = ? WHERE project_name = ?').run(
                description,
                nowSeconds(),
                projectName
            );
        });
    }

    // ─── Stack operations (docker compose CLI) ──────────────────────────

    /** `ComposeManager::buildComposeCmd`, minus the `docker compose` prefix the runner supplies. */
    private stackArgs(projectName: string): { args: string[]; stack: ComposeStackRow | undefined } {
        const stack = this.db.read(
            (db) =>
                db.prepare('SELECT working_dir, compose_file, env_file FROM compose_stacks WHERE project_name = ?')
                    .get(projectName) as ComposeStackRow | undefined
        );

        const args = ['-p', projectName];
        if (stack?.compose_file) args.push('-f', stack.compose_file);
        if (stack?.env_file) args.push('--env-file', stack.env_file);
        return { args, stack };
    }

    /** Replaces PHP's `cd $dir &&` prefix with the `cwd` process option. */
    private cwdFor(stack: Pick<ComposeStackRow, 'working_dir'> | undefined): string | undefined {
        return stack?.working_dir && isDir(stack.working_dir) ? stack.working_dir : undefined;
    }

    /**
     * @param timeoutMs The budget the caller passed to `runner.exec` for
     * this run. Only used to word the timeout message the same way PHP does
     * — see below.
     */
    private toActionResult(result: ComposeExecResult, timeoutMs: number): DockerFoldersComposeActionResult {
        return {
            success: result.success,
            // PHP's `2>&1` merges both streams into `output` before proc_open
            // ever sees them, and leaves its own stderr pipe empty — so
            // `error` in PHP is always `''` on failure, never the reason.
            // Without a shell there is no merge to replicate faithfully, so
            // this concatenates the two streams for `output` (same combined
            // text a PHP user would have seen) and puts the REAL stderr in
            // `error` — a deliberate, reported improvement over PHP's
            // effectively-empty field, not a behavior this port hides.
            output: mergeOutput(result),
            error: result.timedOut
                ? // `execCommand`'s one exception to the empty-`error`-on-failure
                  // rule above (ComposeManager.php:624-636): its own timeout
                  // branch fills `error` with this exact message before the
                  // generic post-loop return is ever reached. `$timeout` there
                  // is the same seconds value the caller passed in — here,
                  // the caller's `timeoutMs` converted back to seconds.
                  `Command timed out after ${Math.round(timeoutMs / 1000)} seconds. It may still be running.`
                : result.success
                  ? null
                  : result.stderr || null,
            // PHP's timeout branch reports -1. A killed child has no exit code.
            exitCode: result.timedOut ? -1 : result.exitCode,
        };
    }

    async stackUp(projectName: string, forceRecreate = false): Promise<DockerFoldersComposeActionResult> {
        const { args, stack } = this.stackArgs(projectName);
        const upArgs = ['compose', ...args, 'up', '-d'];
        if (forceRecreate) upArgs.push('--force-recreate');
        const result = await this.runner.exec(upArgs, { cwd: this.cwdFor(stack), timeoutMs: STACK_COMMAND_TIMEOUT_MS });
        return this.toActionResult(result, STACK_COMMAND_TIMEOUT_MS);
    }

    async stackDown(projectName: string): Promise<DockerFoldersComposeActionResult> {
        const { args, stack } = this.stackArgs(projectName);
        const result = await this.runner.exec(['compose', ...args, 'down'], {
            cwd: this.cwdFor(stack),
            timeoutMs: STACK_COMMAND_TIMEOUT_MS,
        });
        return this.toActionResult(result, STACK_COMMAND_TIMEOUT_MS);
    }

    async stackStop(projectName: string): Promise<DockerFoldersComposeActionResult> {
        const { args, stack } = this.stackArgs(projectName);
        const result = await this.runner.exec(['compose', ...args, 'stop'], {
            cwd: this.cwdFor(stack),
            timeoutMs: STACK_COMMAND_TIMEOUT_MS,
        });
        return this.toActionResult(result, STACK_COMMAND_TIMEOUT_MS);
    }

    /** `ComposeManager::stackRestart`: down, then (only if down succeeded) up, outputs joined with "\n". */
    async stackRestart(projectName: string): Promise<DockerFoldersComposeActionResult> {
        const downResult = await this.stackDown(projectName);
        if (!downResult.success) return downResult;

        const upResult = await this.stackUp(projectName);
        return { ...upResult, output: `${downResult.output ?? ''}\n${upResult.output ?? ''}` };
    }

    async stackPull(projectName: string): Promise<DockerFoldersComposeActionResult> {
        const { args, stack } = this.stackArgs(projectName);
        const result = await this.runner.exec(['compose', ...args, 'pull'], {
            cwd: this.cwdFor(stack),
            timeoutMs: STACK_COMMAND_TIMEOUT_MS,
        });
        return this.toActionResult(result, STACK_COMMAND_TIMEOUT_MS);
    }

    async stackLogs(projectName: string, tail = 100): Promise<DockerFoldersComposeActionResult> {
        const { args, stack } = this.stackArgs(projectName);
        const clampedTail = Math.max(1, Math.min(Math.trunc(tail), 5000));
        const logsTimeoutMs = 30_000;
        const result = await this.runner.exec(
            ['compose', ...args, 'logs', '--no-color', `--tail=${clampedTail}`],
            { cwd: this.cwdFor(stack), timeoutMs: logsTimeoutMs }
        );
        return this.toActionResult(result, logsTimeoutMs);
    }

    /**
     * `dockerFoldersComposeLogStream`'s source: `docker compose logs --follow`,
     * as text chunks instead of one buffered result. Same project/args
     * resolution as `stackLogs` (`stackArgs`, `cwdFor`) — including its total
     * absence of project-name format validation at the SERVICE layer.
     * `ComposeResolver` now validates every `project` argument at the
     * boundary (`isValidProjectName`, mirroring `compose.php`'s dev-branch
     * fix), but neither `stackLogs` nor this method re-checks it here
     * (unlike `streamStackUp`/`streamStackPull`, which still validate against
     * `isValidProjectName` before ever touching the runner, matching
     * `compose-stream.php` validating independently of `compose.php`); an
     * unknown or malformed project simply reaches `docker compose`
     * as `-p <name>`, which itself fails fast with a non-zero exit and a
     * stderr line such as "no configuration file provided" — surfaced here the
     * same way any other stderr line is, as a `'line'` event on the `err`
     * stream from `execStreaming`, no special-casing needed.
     *
     * `timeoutMs: 0` disables `execStreaming`'s own timeout (`timer =
     * timeoutMs > 0 ? setTimeout(...) : null`) — a follow stream is meant to
     * run indefinitely, unlike every other call in this class, which all pass
     * a finite budget.
     *
     * Chunking: raw lines are coalesced into a buffer and flushed at most
     * once every `LOG_STREAM_COALESCE_MS`, never emitting an empty string.
     * `docker compose logs --follow` writes its entire `--tail` backlog to
     * the pipe essentially synchronously when the process starts, well
     * inside one coalescing window, so in practice the first emission holds
     * the whole initial tail and every later emission is newly-appended live
     * output — but that boundary is not explicitly marked in the protocol,
     * only a consequence of the backlog outrunning the timer. A container
     * logging fast enough to fill more than one buffer before the first
     * flush would see its initial tail split across two chunks; a caller
     * that needs a hard guarantee should not rely on chunk boundaries to mean
     * "end of backlog".
     *
     * On the final `'result'` event: whatever is left in the buffer is
     * flushed first (so no trailing partial line is lost), then, if the
     * process exited non-zero (including a `--follow` that failed at
     * startup), one last chunk describing the failure is appended before the
     * Observable completes normally — never as an Observable `error()`, so a
     * subscriber sees an orderly end, not a broken stream. `execStreaming`
     * itself already logs nothing on teardown, so this method adds its own
     * `logger.debug` line when the subscription is torn down (unsubscribe),
     * which is what actually kills the child process — `execStreaming`'s
     * returned teardown calls `child.kill('SIGTERM')` when the process
     * hasn't already settled, and this method does not suppress that.
     */
    logStream(projectName: string, tail = 100): Observable<string> {
        const { args, stack } = this.stackArgs(projectName);
        const clampedTail = Math.max(1, Math.min(Math.trunc(tail), 5000));
        const logArgs = ['compose', ...args, 'logs', '--no-color', '--follow', `--tail=${clampedTail}`];

        return new Observable<string>((subscriber) => {
            let buffer = '';
            let flushTimer: ReturnType<typeof setTimeout> | null = null;

            const flush = (): void => {
                if (buffer === '') return;
                subscriber.next(buffer);
                buffer = '';
            };

            const scheduleFlush = (): void => {
                if (flushTimer) return;
                flushTimer = setTimeout(() => {
                    flushTimer = null;
                    flush();
                }, LOG_STREAM_COALESCE_MS);
            };

            const subscription = this.runner
                .execStreaming(logArgs, { cwd: this.cwdFor(stack), timeoutMs: 0 })
                .subscribe({
                    next: (event) => {
                        if (event.type === 'line') {
                            buffer += buffer === '' ? event.line : `\n${event.line}`;
                            scheduleFlush();
                            return;
                        }

                        // 'result': flush whatever is left, then complete —
                        // matching PHP's "a failed command is a value, never
                        // an Observable error" convention used everywhere
                        // else in this class.
                        if (flushTimer) {
                            clearTimeout(flushTimer);
                            flushTimer = null;
                        }
                        flush();
                        if (!event.success) {
                            subscriber.next(`[docker compose logs exited: ${describeFailure(event)}]`);
                        }
                        subscriber.complete();
                    },
                    error: (error: unknown) => subscriber.error(error),
                });

            return () => {
                this.logger.debug(`Closed compose log stream for ${projectName}`);
                if (flushTimer) clearTimeout(flushTimer);
                subscription.unsubscribe();
            };
        });
    }

    /**
     * `ComposeManager::stackPs`. Calls `isComposeAvailable()` on every
     * invocation (ComposeManager.php:934), which `getAllStacks` then calls
     * once per row — an N-stack list therefore runs `2N` sequential
     * `docker` processes just to render the list. Reported, not fixed:
     * caching availability for the duration of one list request would
     * change behavior if Compose becomes available mid-request, which is
     * exactly the kind of edge case a faithful port should not paper over
     * without being asked.
     *
     * Unlike every other stack action, PHP redirects stderr to `/dev/null`
     * here rather than merging it (`2>/dev/null`, not `2>&1`), so a failure
     * is silently empty — `stderr` from `exec()` is intentionally not read.
     */
    async stackPs(projectName: string): Promise<ComposePsEntry[]> {
        if (!(await this.isComposeAvailable())) return [];

        const { args, stack } = this.stackArgs(projectName);
        const result = await this.runner.exec(['compose', ...args, 'ps', '--format', 'json'], {
            cwd: this.cwdFor(stack),
            timeoutMs: 10_000,
        });

        if (!result.success || result.stdout.trim() === '') return [];

        // `docker compose ps --format json` emits one JSON object per line
        // (NDJSON), not a single array — ComposeManager.php:952-961 parses it
        // the same way. Unverified against the pinned 2.32.4 binary from
        // this environment; if that format changed, this undercounts
        // exactly as the PHP it is ported from would. Not fixed blind.
        const entries: ComposePsEntry[] = [];
        for (const line of result.stdout.trim().split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '') continue;
            try {
                entries.push(JSON.parse(trimmed) as ComposePsEntry);
            } catch {
                // Matches PHP's `if ($svc)` guard after `json_decode`: an
                // unparseable line is silently skipped, not an error.
            }
        }
        return entries;
    }

    /**
     * `ComposeManager::validateComposeContent`. Two genuinely different
     * argument shapes depending on whether `content` is provided, ported
     * exactly as PHP has them (ComposeManager.php:570-633) rather than
     * unified: validating UNSAVED content passes `--project-directory`
     * (works from any `cwd`); validating the file ALREADY ON DISK instead
     * runs with `cwd` set to `working_dir` (PHP's `cd $dir &&`) and no
     * `--project-directory` flag at all. This asymmetry is PHP's, not a
     * porting mistake.
     */
    async validateComposeContent(
        projectName: string,
        content: string | null
    ): Promise<{ success: boolean; output: string; errors: DockerFoldersComposeValidationError[] }> {
        if (!(await this.isComposeAvailable())) {
            return {
                success: false,
                output: '',
                errors: [{ line: 1, column: null, message: 'Docker Compose not available' }],
            };
        }

        const stack = this.db.read(
            (db) =>
                db.prepare(
                    'SELECT working_dir, compose_file, env_file FROM compose_stacks WHERE project_name = ?'
                ).get(projectName) as ComposeStackRow | undefined
        );
        const workingDirValid = this.cwdFor(stack) !== undefined;

        const args = ['compose', '-p', projectName];
        let tmpFile: string | null = null;
        let cwd: string | undefined;

        if (content !== null) {
            tmpFile = join(tmpdir(), `dfm-compose-${randomBytes(8).toString('hex')}`);
            writeFileSync(tmpFile, content, 'utf8');
            args.push('-f', tmpFile);
            if (stack?.env_file) args.push('--env-file', stack.env_file);
            if (workingDirValid) args.push('--project-directory', stack!.working_dir as string);
        } else {
            if (stack?.compose_file) args.push('-f', stack.compose_file);
            if (stack?.env_file) args.push('--env-file', stack.env_file);
            if (workingDirValid) cwd = stack!.working_dir as string;
        }

        args.push('config', '--quiet');

        const result = await this.runner.exec(args, { cwd, timeoutMs: 30_000 });

        if (tmpFile) safeUnlink(tmpFile);

        const combinedOutput = mergeOutput(result);

        let errors: DockerFoldersComposeValidationError[] = [];
        if (!result.success) {
            errors = parseComposeValidationErrors(combinedOutput);
            if (errors.length === 0) {
                errors = [{ line: 1, column: null, message: (combinedOutput || 'Validation failed').trim() }];
            }
        }

        return { success: result.success, output: combinedOutput, errors };
    }

    // ─── Streaming (docker compose pull / up) ───────────────────────────

    /**
     * `ComposeManager::stackUpStreaming`, plus the SSE envelope
     * `compose-stream.php` wraps it in (`sendSSE('status'|'phase'|'log'|
     * 'complete'|'error', ...)` then a final `'done'`), collapsed into one
     * `Observable`. See the class-level doc and the report for exactly what
     * this exposes and what the future subscription resolver still owns
     * (the `management_enabled` gate compose-stream.php:49-53 checks before
     * ever opening the stream — this method does not check it, matching
     * every other "business rule lives at the boundary" decision in this
     * file).
     *
     * The project-name regex IS checked here (unlike `management_enabled`)
     * because `compose-stream.php:43` checks it as a pure input-shape gate
     * with no side effects, cheap enough to duplicate at both layers without
     * the "boundary vs manager" tension that applies to `management_enabled`
     * (which needs an async `docker compose version` call to answer).
     *
     * Not tied to the subscriber's own unsubscribe: PHP's stream sets
     * `ignore_user_abort(true)` (compose-stream.php:58), so the compose
     * command keeps running to completion even if the browser tab closes.
     * This Observable's teardown does not kill the child process, matching
     * that — see the report for the tradeoff (a subscription that is never
     * read to completion cannot cancel the underlying `docker` run through
     * this API; `ComposeRunner.execStreaming` itself DOES kill on
     * unsubscribe, so a caller that wants PHP's leave-it-running behavior
     * must, like this method, not propagate its own unsubscribe downward).
     */
    streamStackUp(projectName: string, forceRecreate: boolean): Observable<DockerFoldersComposeStreamEvent> {
        if (!isValidProjectName(projectName)) {
            throw new BadRequestException('Invalid project name');
        }

        return new Observable<DockerFoldersComposeStreamEvent>((subscriber) => {
            void this.runStackUpSequence(projectName, forceRecreate, subscriber);
            return () => {
                /* intentionally does not cancel the underlying run; see doc above */
            };
        });
    }

    /** `ComposeManager::stackPullStreaming`, same SSE envelope as `streamStackUp`. */
    streamStackPull(projectName: string): Observable<DockerFoldersComposeStreamEvent> {
        if (!isValidProjectName(projectName)) {
            throw new BadRequestException('Invalid project name');
        }

        return new Observable<DockerFoldersComposeStreamEvent>((subscriber) => {
            void this.runStackPullSequence(projectName, subscriber);
            return () => {
                /* intentionally does not cancel the underlying run; see doc above */
            };
        });
    }

    private async runStackUpSequence(
        projectName: string,
        forceRecreate: boolean,
        subscriber: Subscriber<DockerFoldersComposeStreamEvent>
    ): Promise<void> {
        try {
            subscriber.next({ type: 'status', message: `Starting ${projectName}...` });

            const { args, stack } = this.stackArgs(projectName);
            const cwd = this.cwdFor(stack);

            subscriber.next({ type: 'phase', phase: 'pulling', message: 'Pulling images...' });
            const pullResult = await this.relayStreamingPhase(subscriber, ['compose', ...args, 'pull'], {
                cwd,
                timeoutMs: 600_000,
            });

            if (!pullResult.success) {
                // PHP does not abort on a failed pull — a locally-built or
                // partial stack should still get a chance to start.
                subscriber.next({
                    type: 'phase',
                    phase: 'pull_warning',
                    message: 'Pull finished with warnings, continuing...',
                });
            }

            subscriber.next({ type: 'phase', phase: 'starting', message: 'Starting containers...' });
            const upArgs = ['compose', ...args, 'up', '-d'];
            if (forceRecreate) upArgs.push('--force-recreate');
            const upResult = await this.relayStreamingPhase(subscriber, upArgs, { cwd, timeoutMs: 600_000 });

            if (upResult.success) {
                subscriber.next({
                    type: 'complete',
                    message: `${projectName} started successfully`,
                    project: projectName,
                });
            } else {
                subscriber.next({
                    type: 'error',
                    message: `Failed to start ${projectName}: ${describeFailure(upResult)}`,
                });
            }
        } catch (error) {
            subscriber.next({ type: 'error', message: errorMessage(error) });
        } finally {
            // `compose-stream.php`'s final line is `sendSSE('done', ['finished' => true])` —
            // matched here, not just `{type: 'done'}` (a shape gap this port had until it
            // was checked against PHP for the GraphQL subscription work).
            subscriber.next({ type: 'done', finished: true });
            subscriber.complete();
        }
    }

    private async runStackPullSequence(
        projectName: string,
        subscriber: Subscriber<DockerFoldersComposeStreamEvent>
    ): Promise<void> {
        try {
            subscriber.next({ type: 'status', message: `Pulling images for ${projectName}...` });

            const { args, stack } = this.stackArgs(projectName);
            subscriber.next({ type: 'phase', phase: 'pulling', message: 'Pulling images...' });
            const pullResult = await this.relayStreamingPhase(subscriber, ['compose', ...args, 'pull'], {
                cwd: this.cwdFor(stack),
                timeoutMs: 600_000,
            });

            if (pullResult.success) {
                subscriber.next({
                    type: 'complete',
                    message: `Images for ${projectName} pulled successfully`,
                    project: projectName,
                });
            } else {
                subscriber.next({
                    type: 'error',
                    message: `Failed to pull images for ${projectName}: ${describeFailure(pullResult)}`,
                });
            }
        } catch (error) {
            subscriber.next({ type: 'error', message: errorMessage(error) });
        } finally {
            // `compose-stream.php`'s final line is `sendSSE('done', ['finished' => true])` —
            // matched here, not just `{type: 'done'}` (a shape gap this port had until it
            // was checked against PHP for the GraphQL subscription work).
            subscriber.next({ type: 'done', finished: true });
            subscriber.complete();
        }
    }

    /** Runs one `ComposeRunner.execStreaming` call to completion, relaying its lines as 'log' events. */
    private relayStreamingPhase(
        subscriber: Subscriber<DockerFoldersComposeStreamEvent>,
        args: string[],
        options: ComposeRunOptions
    ): Promise<{ success: boolean; exitCode: number | null; timedOut: boolean }> {
        return new Promise((resolve, reject) => {
            this.runner.execStreaming(args, options).subscribe({
                next: (event) => {
                    if (event.type === 'line') {
                        subscriber.next({ type: 'log', stream: event.stream, line: event.line });
                    } else {
                        resolve({ success: event.success, exitCode: event.exitCode, timedOut: event.timedOut });
                    }
                },
                error: reject,
            });
        });
    }

    // ─── File I/O ────────────────────────────────────────────────────────

    getComposeFileContent(projectName: string): composeFiles.FileResult {
        return this.db.read((db) => composeFiles.getComposeFileContent(db, projectName));
    }

    getEnvFileContent(projectName: string): composeFiles.FileResult {
        return this.db.read((db) => composeFiles.getEnvFileContent(db, projectName));
    }

    saveComposeFileContent(
        projectName: string,
        content: string
    ): { success: boolean; error: string | null; path: string | null } {
        return this.db.write((db) => composeFiles.saveComposeFileContent(db, projectName, content));
    }

    saveEnvFileContent(
        projectName: string,
        content: string
    ): { success: boolean; error: string | null; path: string | null } {
        return this.db.write((db) => composeFiles.saveEnvFileContent(db, projectName, content));
    }

    // ─── File versioning ─────────────────────────────────────────────────

    getFileVersions(
        projectName: string,
        fileType: string
    ): { success: boolean; error: string | null; versions: composeFiles.FileVersionRow[] } {
        return this.db.read((db) => composeFiles.getFileVersions(db, projectName, fileType));
    }

    getFileVersionContent(
        projectName: string,
        versionId: number
    ): { success: boolean; error: string | null; version: composeFiles.FileVersionDetail | null } {
        return this.db.read((db) => composeFiles.getFileVersionContent(db, projectName, versionId));
    }

    restoreFileVersion(
        projectName: string,
        versionId: number
    ): { success: boolean; error: string | null; path: string | null } {
        return this.db.write((db) => composeFiles.restoreFileVersion(db, projectName, versionId));
    }

    // ─── Autostart ───────────────────────────────────────────────────────

    /**
     * `ComposeManager::getAutostartStacks`/`startAutostartStacks`/
     * `stopAutostartStacks`. Ported as public methods with no caller: PHP's
     * are invoked from an emhttp event hook on Docker start/stop, which has
     * no equivalent in this plugin yet. Whoever wires that hook should call
     * these directly — see the class doc for why they must NOT go through
     * anything that publishes.
     */
    getAutostartStacks(): ComposeStackRow[] {
        return this.db.read(
            (db) => db.prepare('SELECT * FROM compose_stacks WHERE autostart = 1').all() as ComposeStackRow[]
        );
    }

    async startAutostartStacks(): Promise<Record<string, DockerFoldersComposeActionResult>> {
        if (!(await this.isComposeAvailable())) {
            this.logger.warn('docker compose not available, skipping autostart');
            return {};
        }

        const results: Record<string, DockerFoldersComposeActionResult> = {};
        for (const stack of this.getAutostartStacks()) {
            const result = await this.stackUp(stack.project_name, Number(stack.autostart_force_recreate) === 1);
            results[stack.project_name] = result;
            this.logger.log(`autostart: ${stack.project_name} - ${result.success ? 'OK' : 'FAILED'}`);
        }
        return results;
    }

    async stopAutostartStacks(): Promise<Record<string, DockerFoldersComposeActionResult>> {
        if (!(await this.isComposeAvailable())) return {};

        const results: Record<string, DockerFoldersComposeActionResult> = {};
        for (const stack of this.getAutostartStacks()) {
            const result = await this.stackDown(stack.project_name);
            results[stack.project_name] = result;
            this.logger.log(`shutdown: ${stack.project_name} - ${result.success ? 'OK' : 'FAILED'}`);
        }
        return results;
    }

    // ─── Migration from compose_plugin ───────────────────────────────────

    /**
     * `ComposeManager::importFromComposePlugin`, two phases (ComposeManager.php:1514-1720,
     * d2011ec/451a330/9020f94/31b04c2, all reported to the dev branch): file
     * copies run first, outside any transaction (`buildComposeImportPlan`),
     * and the `compose_stacks`/`folders` rows go in afterwards in one short
     * transaction (`commitComposeImportPlan`). An earlier version of this
     * port ran the copies INSIDE the transaction, matching an older PHP bug
     * where a later row's failure rolled back the database but left
     * already-copied files on disk for the projects processed before it —
     * that bug is fixed on the dev branch and this now matches the fix, not
     * the bug.
     */
    importFromComposePlugin(): {
        success: boolean;
        stacksImported: number;
        stacksSkipped: number;
        errors: string[];
    } {
        if (!isDir(this.paths.pluginProjectsDir)) {
            return {
                success: false,
                stacksImported: 0,
                stacksSkipped: 0,
                errors: ['Compose plugin projects directory not found'],
            };
        }

        let entries: string[];
        try {
            entries = readdirSync(this.paths.pluginProjectsDir);
        } catch {
            return {
                success: false,
                stacksImported: 0,
                stacksSkipped: 0,
                errors: ['Failed to scan compose plugin projects directory'],
            };
        }

        const result = { success: true, stacksImported: 0, stacksSkipped: 0, errors: [] as string[] };

        const plans: ComposeImportPlan[] = [];
        for (const entry of entries) {
            this.buildComposeImportPlan(entry, result, plans);
        }

        if (plans.length === 0) {
            return result;
        }

        try {
            this.db.write((db) => {
                for (const plan of plans) {
                    this.commitComposeImportPlan(db, plan, result);
                }
            });
        } catch (error) {
            result.success = false;
            result.stacksImported = 0;
            result.errors.push(errorMessage(error));
            this.cleanupFailedComposeImport(plans);
        }

        return result;
    }

    /**
     * Phase 1 of `importFromComposePlugin`: validate one `compose_plugin`
     * project directory, copy its files into this plugin's own stacks
     * directory, and queue a plan for phase 2 — everything ComposeManager.php
     * does between `beginTransaction()`'s old position and the new one
     * (ComposeManager.php:1519-1620). Runs with no open write transaction.
     */
    private buildComposeImportPlan(
        entry: string,
        result: { errors: string[]; stacksSkipped: number },
        plans: ComposeImportPlan[]
    ): void {
        const projectPath = `${this.paths.pluginProjectsDir}/${entry}`;
        if (!isDir(projectPath)) return;

        // compose.php and compose-stream.php refuse any other name
        // (`isValidProjectName`, ported from `safeComposeProjectParam` —
        // ComposeManager.php:1525-1531, 31b04c2), so a stack imported under
        // one could never be started, edited, or deleted. This also keeps
        // hidden directories such as ".git" out.
        if (!isValidProjectName(entry)) {
            result.errors.push(`${entry}: unsupported project name, skipped`);
            return;
        }

        const projectName = entry;

        // Check if already imported.
        const existing = this.db.read((db) =>
            db.prepare('SELECT project_name FROM compose_stacks WHERE project_name = ?').get(projectName)
        );
        if (existing) {
            result.stacksSkipped++;
            return;
        }

        const name = readMetadataFile(`${projectPath}/name`);
        const description = readMetadataFile(`${projectPath}/description`);
        const autostart = (readMetadataFile(`${projectPath}/autostart`) ?? '').toLowerCase() === 'true';
        const isIndirect = existsSync(`${projectPath}/indirect`);

        let sourceDir: string | null = null;
        if (isIndirect) {
            const indirectPath = readMetadataFile(`${projectPath}/indirect`);
            if (indirectPath && isDir(indirectPath)) sourceDir = indirectPath;
        } else {
            sourceDir = projectPath;
        }

        const sourceComposeFile = sourceDir ? findComposeFile(sourceDir) : null;

        // Copy files into our own plugin directory so stacks are self-contained.
        const destDir = `${this.paths.stacksDir}/${projectName}`;
        let createdDir = false;
        if (!existsSync(destDir)) {
            try {
                mkdirSync(destDir, { recursive: true });
                createdDir = true;
            } catch {
                // Matches PHP's `@mkdir` — best effort, failure surfaces
                // later as a failed file copy instead.
            }
        }

        let composeFile: string | null = null;
        let envFile: string | null = null;
        // A file is recorded as copied only when this run created it. One
        // that was already there is overwritten, but a rollback must not
        // delete it (451a330, reported to the dev branch).
        const copied: string[] = [];

        if (sourceComposeFile && existsSync(sourceComposeFile)) {
            const destFile = `${destDir}/${basename(sourceComposeFile)}`;
            const existed = existsSync(destFile);
            try {
                copyFileSync(sourceComposeFile, destFile);
                composeFile = destFile;
                if (!existed) copied.push(destFile);
            } catch {
                result.errors.push(`${projectName}: failed to copy compose file`);
            }
        }

        // Copy .env if it exists in source.
        if (sourceDir && existsSync(`${sourceDir}/.env`)) {
            const destEnv = `${destDir}/.env`;
            const existed = existsSync(destEnv);
            try {
                copyFileSync(`${sourceDir}/.env`, destEnv);
                envFile = destEnv;
                if (!existed) copied.push(destEnv);
            } catch {
                // Matches PHP: a failed `.env` copy is silently skipped, not
                // pushed onto `errors`.
            }
        }

        plans.push({
            project: projectName,
            name,
            description,
            autostart,
            workingDir: destDir,
            composeFile,
            envFile,
            createdDir,
            copied,
        });
    }

    /**
     * Phase 2 of `importFromComposePlugin`: insert one plan's
     * `compose_stacks`/`folders` rows, inside the caller's write transaction.
     * `ComposeManager.php`'s per-plan loop body (ComposeManager.php:1629-1684).
     */
    private commitComposeImportPlan(
        db: DatabaseSync,
        plan: ComposeImportPlan,
        result: { stacksImported: number; stacksSkipped: number }
    ): void {
        // Checked again inside the transaction. An import that overlapped
        // this one (a double click) can have committed the same project
        // since the copy phase above. Its row points at the files this run
        // copied over, so they must not be removed by the rollback cleanup
        // below (d2011ec, reported to the dev branch).
        const taken = db.prepare('SELECT project_name FROM compose_stacks WHERE project_name = ?').get(plan.project);
        if (taken) {
            plan.copied = [];
            plan.createdDir = false;
            result.stacksSkipped++;
            return;
        }

        const now = nowSeconds();

        // Insert compose_stacks row.
        db.prepare(
            `INSERT INTO compose_stacks
                (project_name, working_dir, compose_file, env_file, autostart,
                 autostart_force_recreate, description, imported_from, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, 'compose_plugin', ?, ?)`
        ).run(
            plan.project,
            plan.workingDir,
            plan.composeFile,
            plan.envFile,
            plan.autostart ? 1 : 0,
            // PHP: `$description ?: ($name ?: null)`. PHP's `?:` treats the
            // string "0" as falsy; JS's `||` does not — a metadata file
            // containing the literal text "0" would keep "0" here but fall
            // through to `$name`/null in PHP. Reported; not worth guarding
            // against for a value no real compose_plugin install produces.
            plan.description || plan.name || null,
            now,
            now
        );

        // Create a folder if one doesn't exist for this project.
        const existingFolder = db.prepare('SELECT id FROM folders WHERE compose_project = ?').get(plan.project);
        if (!existingFolder) {
            const maxPositionRow = db.prepare('SELECT MAX(position) AS value FROM folders').get() as
                | { value: number | null }
                | undefined;
            const position = (maxPositionRow?.value ?? -1) + 1;
            db.prepare(
                `INSERT INTO folders
                    (name, icon, color, position, collapsed, compose_project, sort_mode, created_at, updated_at)
                 VALUES (?, 'layer-group', NULL, ?, 0, ?, 'manual', ?, ?)`
            ).run(plan.name || plan.project, position, plan.project, now, now);
        }

        result.stacksImported++;
    }

    /**
     * `ComposeManager::importFromComposePlugin`'s catch block
     * (ComposeManager.php:1693-1718, 9020f94, reported to the dev branch): a
     * failed transaction means no row survived, so remove what THIS run
     * copied — only files it wrote, and a directory only if it created it
     * (`safeRmdir` only removes an empty one, silently, matching `@rmdir`).
     * A racing import can have committed any of these projects between the
     * copy phase and now, and its row points at these same files, so this
     * looks again before deleting anything. If that lookup itself throws,
     * the files are kept: an orphan is safer than deleting a live stack's
     * compose file.
     */
    private cleanupFailedComposeImport(plans: ComposeImportPlan[]): void {
        for (const plan of plans) {
            let owned: unknown;
            try {
                owned = this.db.read((db) =>
                    db.prepare('SELECT project_name FROM compose_stacks WHERE project_name = ?').get(plan.project)
                );
            } catch {
                owned = true;
            }
            if (owned) continue;

            for (const file of plan.copied) {
                safeUnlink(file);
            }
            if (plan.createdDir) {
                safeRmdir(plan.workingDir);
            }
        }
    }

    /**
     * `ComposeManager::exportConfigs`. Validated inside the service, unlike
     * `set_env_path` — matching PHP exactly (ComposeManager.php:1549-1567):
     * `settings.php` also checks `compose_export_dir` at write time, but
     * this guards a value stored before that check existed, so the manager
     * checks again rather than trusting the caller.
     *
     * Fixed over the PHP (ComposeManager.php:1585, reported to the dev
     * branch). `project_name` is written unchecked from a container's
     * `com.docker.compose.project` label, and PHP appends it to the export
     * directory as is, so a label of `../../../etc` wrote outside it. Here a
     * name that fails `safeProjectName` is skipped and reported, and the
     * joined directory is checked to still sit inside the export directory.
     */
    exportConfigs(exportDir?: string | null): {
        success: boolean;
        error: string | null;
        exported: number | null;
        errors: string[];
        path: string | null;
    } {
        const requested = exportDir || this.paths.stacksDir;
        const normalized = normalizePath(requested);
        if (normalized === null) {
            return { success: false, error: 'Export directory must be an absolute path', exported: null, errors: [], path: null };
        }

        const allowedRoots = exportAllowedRoots(this.paths);
        if (!pathIsWithinAny(normalized, allowedRoots)) {
            return {
                success: false,
                error: `Export directory must be under ${allowedRoots.join(' or ')}`,
                exported: null,
                errors: [],
                path: null,
            };
        }

        if (!existsSync(normalized)) {
            try {
                mkdirSync(normalized, { recursive: true });
            } catch {
                return {
                    success: false,
                    error: `Failed to create export directory: ${normalized}`,
                    exported: null,
                    errors: [],
                    path: null,
                };
            }
        }

        try {
            accessSync(normalized, fsConstants.W_OK);
        } catch {
            return {
                success: false,
                error: `Export directory is not writable: ${normalized}`,
                exported: null,
                errors: [],
                path: null,
            };
        }

        const stacks = this.db.read(
            (db) => db.prepare('SELECT project_name FROM compose_stacks').all() as { project_name: string }[]
        );

        let exported = 0;
        const errors: string[] = [];

        for (const { project_name: projectName } of stacks) {
            const projectDir = `${normalized}/${projectName}`;
            if (safeProjectName(projectName) === null || !pathIsWithin(projectDir, normalized)) {
                errors.push(`Skipped ${projectName}: not a valid project name`);
                continue;
            }
            if (!existsSync(projectDir)) {
                try {
                    mkdirSync(projectDir, { recursive: true });
                } catch {
                    errors.push(`Failed to create directory for ${projectName}`);
                    continue;
                }
            }

            const compose = this.getComposeFileContent(projectName);
            if (compose.success && compose.content) {
                const filename = compose.path ? basename(compose.path) : 'docker-compose.yml';
                try {
                    writeFileSync(`${projectDir}/${filename}`, compose.content, 'utf8');
                } catch {
                    errors.push(`Failed to write compose file for ${projectName}`);
                    continue;
                }
            }

            const env = this.getEnvFileContent(projectName);
            if (env.success && env.content) {
                try {
                    writeFileSync(`${projectDir}/.env`, env.content, 'utf8');
                } catch {
                    errors.push(`Failed to write env file for ${projectName}`);
                }
            }

            exported++;
        }

        return { success: true, error: null, exported, errors, path: normalized };
    }
}

// ─── Free functions ──────────────────────────────────────────────────────

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function readMetadataFile(path: string): string | null {
    if (!existsSync(path)) return null;
    try {
        return readFileSync(path, 'utf8').trim();
    } catch {
        return null;
    }
}

function safeUnlink(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // Matches PHP's `@unlink`.
    }
}

/** Matches PHP's `@rmdir` — only removes an empty directory, silently doing nothing otherwise. */
function safeRmdir(path: string): void {
    try {
        rmdirSync(path);
    } catch {
        // Not empty, already gone, or some other failure — same as PHP's `@rmdir`.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** See `toActionResult` for why this exists instead of trusting PHP's `2>&1`. */
function mergeOutput(result: ComposeExecResult): string {
    return [result.stdout, result.stderr].filter((part) => part !== '').join('\n');
}

function describeFailure(result: { timedOut: boolean; exitCode: number | null }): string {
    return result.timedOut ? 'Command timed out' : `Exit code ${result.exitCode ?? '?'}`;
}

function sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * `ComposeManager::parseComposeServiceNames`'s path-resolution guard,
 * separated from the pure text parser (`parseComposeServiceNames` in
 * `compose-files.ts`). PHP bug ported as-is: this requires `compose_file` to
 * be explicitly set (ComposeManager.php:257) before even trying to resolve a
 * path, even though `resolveComposeFilePath` would otherwise happily fall
 * back to scanning `working_dir` for a default filename when `compose_file`
 * is empty. A stack with only a `working_dir` (no `compose_file` yet) shows
 * no service-name preview, though its compose FILE reads elsewhere
 * (`getComposeFileContent`) do not have this restriction.
 */
function resolveServiceNames(stack: StackFileFields): string[] {
    if (!stack.compose_file) return [];
    const path = composeFiles.resolveComposeFilePath(stack);
    if (!path || !existsSync(path)) return [];
    try {
        return parseComposeServiceNames(readFileSync(path, 'utf8'));
    } catch {
        return [];
    }
}

/** `ComposeManager::parseComposeValidationErrors`. */
function parseComposeValidationErrors(output: string): DockerFoldersComposeValidationError[] {
    if (output === '') return [];

    const errors: DockerFoldersComposeValidationError[] = [];
    for (const rawLine of output.trim().split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '') continue;

        // "yaml: line N: msg" / "line N: msg" / "in compose.yaml, line N column C: msg"
        const match = line.match(/line\s+(\d+)(?:\s*,?\s*column\s+(\d+))?[\s:]+(.*)$/i);
        if (match) {
            errors.push({
                line: Number(match[1]),
                column: match[2] !== undefined && match[2] !== '' ? Number(match[2]) : 1,
                message: match[3].trim(),
            });
            continue;
        }

        if (/validating/i.test(line) || /invalid/i.test(line) || /error/i.test(line)) {
            errors.push({ line: 1, column: 1, message: line });
        }
    }
    return errors;
}
