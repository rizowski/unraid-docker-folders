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
import { removeComposeStack, type RemoveContainer, type RemoveStackResult } from './compose-remove.js';
import { PIN_FILE, nameFromFolder, nameFromLabels, type LabelledContainer } from './compose-project-name.js';
import { importedCopies, readMetadataFile, repairImportedStacks, sourceDirOf } from './compose-repair.js';
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
 * `importFromComposePlugin` and consumed by `commitComposeImportPlan`.
 */
interface ComposeImportPlan {
    project: string;
    /** The human name: the folder's `name` file, else its directory name. */
    display: string;
    description: string | null;
    autostart: boolean;
    /** The stack's own folder under the Compose Manager projects directory (or its indirect target). */
    workingDir: string;
    composeFile: string | null;
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

/** `ComposeManager::FLASH_COPY_WARNING`. */
const FLASH_COPY_WARNING =
    'Docker Compose is installed, but the copy on the flash drive failed, so it is downloaded again at boot.';

/** `ComposeManager::SETTING_SAVE_WARNING`. */
const SETTING_SAVE_WARNING =
    'Docker Compose is installed, but the setting to reinstall it after a reboot could not be saved.';

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
     *
     * `persist` is true for an install the user started (the banner's
     * button): a success then turns on `compose_auto_install` when the user
     * never chose a value (no stored row), so the flash copy is kept and
     * restored at boot. A stored off stays off and no flash copy is written.
     * The default leaves the setting alone.
     */
    async installComposeBinary(options: { persist?: boolean } = {}): Promise<{ success: boolean; error: string | null; warning?: string }> {
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

        // Only when the user never chose: a stored value, on or off, stays.
        // The binary is already in place, so a settings failure must not fail
        // the install: it becomes a warning (same as PHP).
        const warnings: string[] = [];
        let settingFailed = false;
        let autoInstall = false;
        try {
            if (options.persist && !this.hasAutoInstallChoice()) {
                this.enableAutoInstall();
            }
        } catch (error) {
            this.logger.warn(`Could not save compose_auto_install: ${errorMessage(error)}`);
            settingFailed = true;
        }
        try {
            autoInstall = this.isAutoInstallEnabled();
        } catch (error) {
            this.logger.warn(`Could not read compose_auto_install: ${errorMessage(error)}`);
            settingFailed = true;
        }
        if (settingFailed) warnings.push(SETTING_SAVE_WARNING);

        if (autoInstall) {
            const cached = await this.cacheComposeBinary({ sourceVerified: true });
            if (!cached.success) {
                this.logger.warn(`No flash copy of Docker Compose: ${cached.error}`);
                // The install worked. Say that the copy did not (same wording
                // as `ComposeManager::FLASH_COPY_WARNING`).
                warnings.push(FLASH_COPY_WARNING);
            }
        }

        if (warnings.length > 0) {
            return { success: true, error: null, warning: warnings.join(' ') };
        }

        return { success: true, error: null };
    }

    // ─── Reinstall after reboot ─────────────────────────────────────────
    //
    // `compose-autostart.php` restores the binary from the flash copy at
    // boot. That hook is PHP in both backend modes, so the plugin only keeps
    // the copy current. The rules match `ComposeManager.php`.

    /** `ComposeManager::isAutoInstallEnabled`. */
    isAutoInstallEnabled(): boolean {
        return this.readAutoInstallRow()?.value === '1';
    }

    private readAutoInstallRow(): { value: string } | undefined {
        return this.db.read(
            (db) =>
                db.prepare("SELECT value FROM settings WHERE key = 'compose_auto_install'").get() as
                    | { value: string }
                    | undefined
        );
    }

    /** `ComposeManager::hasAutoInstallChoice`: a stored row, on or off. */
    hasAutoInstallChoice(): boolean {
        return this.readAutoInstallRow() !== undefined;
    }

    /** `ComposeManager::enableAutoInstall`. */
    enableAutoInstall(): void {
        this.db.write((db) =>
            db
                .prepare(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('compose_auto_install', '1', ?) " +
                        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
                )
                .run(nowSeconds())
        );
    }

    /**
     * `ComposeManager::cacheComposeBinary`. A copy of the same size already
     * on flash is kept without reading it back: it was verified when it was
     * written, and the boot restore hashes it again before it runs.
     */
    async cacheComposeBinary(
        options: { sourceVerified?: boolean } = {}
    ): Promise<{ success: boolean; error: string | null }> {
        const source = this.paths.binaryPath;
        const dest = this.paths.cachePath;
        if (!isFile(source)) {
            return { success: false, error: 'Docker Compose is not installed' };
        }
        if (!options.sourceVerified && (await sha256File(source)) !== this.paths.binarySha256) {
            return {
                success: false,
                error: `the installed Docker Compose is not the pinned ${this.paths.binaryVersion} build, so no copy was kept`,
            };
        }
        if (isFile(dest) && statSync(dest).size === statSync(source).size) {
            return { success: true, error: null };
        }
        const tmp = `${dest}.tmp`;
        try {
            copyFileSync(source, tmp);
            chmodSync(tmp, 0o755);
            renameSync(tmp, dest);
        } catch {
            safeUnlink(tmp);
            return { success: false, error: `the copy could not be written to ${dirname(dest)}` };
        }
        return { success: true, error: null };
    }

    /** `ComposeManager::removeCachedComposeBinary`, including a half-written copy. */
    removeCachedComposeBinary(): void {
        safeUnlink(this.paths.cachePath);
        safeUnlink(`${this.paths.cachePath}.tmp`);
    }

    /**
     * The side effect `settings.php` runs after it stores
     * `compose_auto_install`: take a copy when it is switched on and compose
     * is installed, drop it when it is switched off.
     */
    async applyAutoInstallSetting(value: string): Promise<{ success: boolean; error: string | null }> {
        if (value !== '1') {
            this.removeCachedComposeBinary();
            return { success: true, error: null };
        }
        if (!isFile(this.paths.binaryPath)) {
            return { success: true, error: null };
        }
        const cached = await this.cacheComposeBinary();
        if (!this.isAutoInstallEnabled()) {
            // Switched off while this call copied.
            this.removeCachedComposeBinary();
            return { success: true, error: null };
        }
        return cached;
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
     * `ComposeManager::getAllStacks`. Checks for Compose once, then runs
     * `docker compose ps` per stack to count running services, sequentially
     * like PHP's loop (ComposeManager.php:244-269) rather than
     * `Promise.all`, so a production Docker daemon sees one `docker` process
     * at a time instead of a burst.
     */
    async getAllStacks(): Promise<DockerFoldersComposeStack[]> {
        const rows = this.db.read(
            (db) => db.prepare('SELECT * FROM compose_stacks ORDER BY project_name ASC').all() as ComposeStackRow[]
        );

        const stacks: DockerFoldersComposeStack[] = [];
        const available = rows.length > 0 && (await this.isComposeAvailable());
        for (const row of rows) {
            const ps = await this.stackPs(row.project_name, available);
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
     * `ComposeManager::removeStack`: drop a stack's row, its schedules and its
     * stack folder, and with `deleteFiles` the plugin's own copy of its files.
     * Never touches a container, and never publishes (the resolver does).
     */
    removeStack(projectName: string, deleteFiles: boolean, containers: readonly RemoveContainer[]): RemoveStackResult {
        return removeComposeStack(this.db, projectName, deleteFiles, containers, this.paths.stacksDir);
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
     * `ComposeManager::stackPs`.
     *
     * `composeAvailable` lets a caller that asks for many stacks check for
     * Compose once. `getAllStacks` does, the way PHP's `isComposeAvailable()`
     * now keeps its answer for the request, so a list of N stacks runs N + 1
     * `docker` processes rather than 2N.
     *
     * Unlike every other stack action, PHP redirects stderr to `/dev/null`
     * here rather than merging it (`2>/dev/null`, not `2>&1`), so a failure
     * is silently empty — `stderr` from `exec()` is intentionally not read.
     */
    async stackPs(projectName: string, composeAvailable?: boolean): Promise<ComposePsEntry[]> {
        if (!(composeAvailable ?? (await this.isComposeAvailable()))) return [];

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
     * `ComposeManager::importFromComposePlugin`. Adopts each project of
     * dcflachs/compose_plugin or Compose Manager Plus in place. Nothing is
     * copied: one `compose_stacks` row points at the stack's own Compose
     * Manager folder, the same row the container-list sync makes from the
     * labels of a running stack, so the two resolve to one row and one folder.
     *
     * The row's `project_name` is the name the stack runs under: the project
     * label of containers whose working_dir label is the stack's folder, else
     * Compose Manager's own rule (`compose-project-name.ts`). A stack whose
     * name Compose would refuse, whose containers disagree on the name, or
     * whose name is already a stack at another path is skipped, with an error.
     *
     * Not handled: Compose Manager's override file, its env path file, and a
     * stack with several compose files. Only the first compose file found in
     * the folder is used. A stack whose "indirect" target is missing is skipped.
     *
     * `containers` is what the resolver listed from Docker. It is a parameter
     * because a failed listing must stop the import before it names anything.
     */
    importFromComposePlugin(containers: readonly LabelledContainer[]): {
        success: boolean;
        stacksImported: number;
        stacksSkipped: number;
        errors: string[];
    } {
        const projectsDir = this.paths.pluginProjectsDir;
        if (!isDir(projectsDir)) {
            return {
                success: false,
                stacksImported: 0,
                stacksSkipped: 0,
                errors: ['Compose plugin projects directory not found'],
            };
        }

        let entries: string[];
        try {
            entries = readdirSync(projectsDir);
        } catch {
            return {
                success: false,
                stacksImported: 0,
                stacksSkipped: 0,
                errors: ['Failed to scan compose plugin projects directory'],
            };
        }

        const result = { success: true, stacksImported: 0, stacksSkipped: 0, errors: [] as string[] };

        // A copy an earlier version of this import made is merged into its
        // running counterpart, or renamed, first. Whatever stays is left
        // alone, and the loop below must not add a second row for it.
        const copyDirs = this.db.write((db) => {
            repairImportedStacks(db, this.paths);
            return new Set(importedCopies(db, this.paths.stacksDir).map((copy) => copy.dir));
        });

        const legacyOrigin = isFile(`${dirname(projectsDir)}/legacy-origin`);
        const plusInstalled = isFile(`${this.paths.pluginDir}/include/ProjectIdentity.php`);

        const plans: ComposeImportPlan[] = [];
        const planned = new Map<string, string>();
        for (const entry of entries) {
            const projectPath = `${projectsDir}/${entry}`;
            if (!isDir(projectPath)) continue;

            // Keeps hidden directories such as ".git" out, and any name that
            // is not one path segment.
            if (!isValidProjectName(entry)) {
                result.errors.push(`${entry}: unsupported folder name, skipped`);
                continue;
            }
            if (copyDirs.has(entry)) {
                result.errors.push(
                    `${entry}: an earlier import copied this stack and it could not be matched to the original, so it was left as it is`
                );
                continue;
            }

            const displayName = readMetadataFile(`${projectPath}/name`);
            const description = readMetadataFile(`${projectPath}/description`);
            const autostart = (readMetadataFile(`${projectPath}/autostart`) ?? '').toLowerCase() === 'true';

            const sourceDir = sourceDirOf(projectPath);
            if (sourceDir === null) {
                result.errors.push(`${entry}: its folder is indirect and the target is missing, skipped`);
                continue;
            }

            // (1) The name a running stack carries.
            const fromLabels = nameFromLabels(containers, [projectPath, sourceDir]);
            if (fromLabels.error !== null) {
                result.errors.push(`${entry}: ${fromLabels.error}, skipped`);
                continue;
            }
            let projectName = fromLabels.name;

            // (2) Compose Manager's own rule.
            if (projectName === null) {
                const rule = nameFromFolder({
                    dirName: entry,
                    displayName,
                    pinned: readMetadataFile(`${projectPath}/${PIN_FILE}`),
                    plusInstalled,
                    legacyOrigin,
                });
                if (rule.name === null) {
                    result.errors.push(`${entry}: no project name Compose accepts (${rule.error}), skipped`);
                    continue;
                }
                projectName = rule.name;
            }

            const plannedBy = planned.get(projectName);
            if (plannedBy !== undefined) {
                result.errors.push(
                    `${entry}: project name "${projectName}" is already taken by the stack in "${plannedBy}", skipped`
                );
                continue;
            }

            const existing = this.db.read(
                (db) =>
                    db.prepare('SELECT working_dir FROM compose_stacks WHERE project_name = ?').get(projectName) as
                        | { working_dir: string | null }
                        | undefined
            );
            if (existing !== undefined && normalizePath(existing.working_dir) !== normalizePath(sourceDir)) {
                result.errors.push(`${entry}: project name "${projectName}" is already a stack at another path, skipped`);
                continue;
            }

            planned.set(projectName, entry);
            plans.push({
                project: projectName,
                display: displayName || entry,
                description,
                autostart,
                workingDir: sourceDir,
                composeFile: findComposeFile(sourceDir),
            });
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
        }

        return result;
    }

    /**
     * Insert, or adopt, one plan's `compose_stacks` and `folders` rows, inside
     * the caller's write transaction. Read inside it: the container-list sync
     * can have added the row since the plan was made, and that row is adopted
     * instead of getting a second one.
     */
    private commitComposeImportPlan(
        db: DatabaseSync,
        plan: ComposeImportPlan,
        result: { stacksImported: number; stacksSkipped: number }
    ): void {
        const now = nowSeconds();
        const row = db.prepare('SELECT * FROM compose_stacks WHERE project_name = ?').get(plan.project) as
            | ComposeStackRow
            | undefined;

        if (row !== undefined) {
            const sets: string[] = [];
            const values: (string | number)[] = [];
            if (row.imported_from !== 'compose_plugin') sets.push("imported_from = 'compose_plugin'");
            const description = plan.description || plan.display;
            if (!row.description && description) {
                sets.push('description = ?');
                values.push(description);
            }
            if (!row.autostart && plan.autostart) sets.push('autostart = 1');
            if (!row.compose_file && plan.composeFile) {
                sets.push('compose_file = ?');
                values.push(plan.composeFile);
            }
            if (sets.length === 0) {
                result.stacksSkipped++;
            } else {
                db.prepare(`UPDATE compose_stacks SET ${sets.join(', ')}, updated_at = ? WHERE project_name = ?`).run(
                    ...values,
                    now,
                    plan.project
                );
                result.stacksImported++;
            }
        } else {
            db.prepare(
                `INSERT INTO compose_stacks
                    (project_name, working_dir, compose_file, env_file, autostart,
                     autostart_force_recreate, description, imported_from, created_at, updated_at)
                 VALUES (?, ?, ?, NULL, ?, 0, ?, 'compose_plugin', ?, ?)`
            ).run(
                plan.project,
                plan.workingDir,
                plan.composeFile,
                plan.autostart ? 1 : 0,
                plan.description || plan.display,
                now,
                now
            );
            result.stacksImported++;
        }

        // One folder per project name. The sync matches it by compose_project.
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
            ).run(plan.display, position, plan.project, now, now);
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

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function safeUnlink(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // Matches PHP's `@unlink`.
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
