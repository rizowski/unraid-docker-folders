import { Args, Int, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { BadRequestException, ForbiddenException, Inject, NotFoundException, Optional } from '@nestjs/common';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { EventBusService } from '../events/event-bus.service.js';
import { pathIsWithinAny, resolveAgainst } from '../paths/paths.js';
import { mapObservable, observableToAsyncIterator } from '../util/observable-to-async-iterator.js';
import { DockerFoldersStreamEvent, toStreamEvent } from '../streaming/stream-event.js';
import {
    COMPOSE_PATHS_TOKEN,
    DEFAULT_COMPOSE_PATHS,
    composeAllowedRoots,
    type ComposePathsConfig,
} from './compose-config.js';
import {
    DockerFoldersComposeActionResult,
    DockerFoldersComposeAutostartInput,
    DockerFoldersComposeCreateInput,
    DockerFoldersComposeCreateResult,
    DockerFoldersComposeExportResult,
    DockerFoldersComposeFileContent,
    DockerFoldersComposeFileVersion,
    DockerFoldersComposeFileVersionDetail,
    DockerFoldersComposeImportResult,
    DockerFoldersComposeInstallResult,
    DockerFoldersComposeLogChunk,
    DockerFoldersComposeStack,
    DockerFoldersComposeStatus,
    DockerFoldersComposeValidateResult,
} from './compose.model.js';
import { ComposeService, isValidProjectName } from './compose.service.js';

/**
 * The HTTP boundary for Compose, ported from `api/compose.php`.
 *
 * PUBLISHING AND THE `management_enabled` GATE LIVE HERE, NOT IN
 * `ComposeService` — see that class's doc comment for the full reasoning
 * (PHP's `WebSocketPublisher` calls all live in `api/compose.php`, never in
 * `ComposeManager.php`, and there is a real second caller of the manager —
 * the autostart hooks — that must never publish). The table below is the
 * exact per-action behavior this resolver reproduces, action name from
 * `api/compose.php` in parentheses:
 *
 * | Mutation                          | (PHP action)     | gate | publish (condition)                  |
 * |------------------------------------|------------------|------|----------------------------------------|
 * | installDockerFoldersComposeBinary  | install_binary   | no   | none                                    |
 * | exportDockerFoldersComposeConfigs  | export_configs   | no   | none                                    |
 * | createDockerFoldersComposeStack    | create           | no   | compose/create + folder/updated (always, on success) |
 * | importDockerFoldersComposeStacks   | import           | no   | compose/import (only if stacksImported > 0) |
 * | bringUpDockerFoldersComposeStack   | up               | yes  | compose/up (always, even on failure)   |
 * | bringDownDockerFoldersComposeStack | down             | yes  | compose/down (always)                  |
 * | stopDockerFoldersComposeStack      | stop             | yes  | compose/stop (always)                  |
 * | restartDockerFoldersComposeStack   | restart          | yes  | compose/restart (always)               |
 * | pullDockerFoldersComposeStack      | pull             | yes  | compose/pull (always)                  |
 * | validateDockerFoldersComposeContent| validate         | no   | none                                    |
 * | saveDockerFoldersComposeFile       | save_file        | yes  | compose/save_file (only on success)    |
 * | saveDockerFoldersComposeEnv        | save_env         | yes  | compose/save_env (only on success)     |
 * | restoreDockerFoldersComposeFileVersion | restore_version | yes | compose/restore_version (only on success) |
 * | setDockerFoldersComposeEnvPath     | set_env_path     | yes  | compose/set_env_path (always, on success) |
 * | setDockerFoldersComposeAutostart   | autostart        | yes  | compose/autostart (always)             |
 * | setDockerFoldersComposeDescription | set_description  | NO   | none — the one write action PHP never gates |
 * | dockerFoldersComposeStream (subscription) | up / pull (compose-stream.php) | yes | compose/{action} (only when the stream reaches its 'complete' event, matching PHP's `if ($result['success'])`) |
 * | dockerFoldersComposeLogStream (subscription) | — (no PHP equivalent; replaces polling `logs`) | no | none — a read, like `dockerFoldersComposeLogs` |
 *
 * "gate" = `errorResponse('Compose management is disabled...', 403)` when
 * `!status.managementEnabled`, ported here as `ForbiddenException`.
 * `setDockerFoldersComposeDescription` having no gate and no publish is a PHP
 * inconsistency (every other write action has at least one of the two),
 * reported in the port summary, not fixed.
 *
 * PROJECT-NAME VALIDATION ALSO LIVES HERE, mirroring `compose.php`'s
 * dev-branch fix (49a9a1b, then 7ded47c): every action above that takes a
 * `project` argument validates it with `isValidProjectName` (`compose.service.ts`)
 * before doing anything else — before the `management_enabled` gate on a
 * gated action — via `requireValidProjectName`. Skipped only when `project`
 * is `''`, mirroring `compose.php`'s `$projectParam !== null && $projectParam
 * !== ''` guard (a required GraphQL `String!` argument is never null, so `''`
 * is the only pass-through case left). `dockerFoldersComposeStream` does NOT
 * use that skip: `compose-stream.php` rejects an empty project on its own,
 * separately from the name-shape check, so its handler calls
 * `isValidProjectName` directly instead of going through
 * `requireValidProjectName`.
 */
@Resolver()
export class ComposeResolver {
    constructor(
        private readonly compose: ComposeService,
        private readonly events: EventBusService,
        @Optional()
        @Inject(COMPOSE_PATHS_TOKEN)
        private readonly paths: ComposePathsConfig = DEFAULT_COMPOSE_PATHS
    ) {}

    /**
     * `api/compose.php`'s project-name check (49a9a1b, then 7ded47c;
     * both reported to the dev branch), applied at this boundary to every
     * action that takes a `project` argument. Skipped when `project` is `''`,
     * matching PHP's `$projectParam !== null && $projectParam !== ''` guard —
     * a required GraphQL `String!` argument is never null, so `''` is the
     * only pass-through case left.
     *
     * NOT used by `dockerFoldersComposeStream`: `compose-stream.php` rejects
     * an empty project on its own (`!$project`), separately from and before
     * the name-shape check, so that handler calls `isValidProjectName`
     * directly instead.
     */
    private requireValidProjectName(project: string): void {
        if (project !== '' && !isValidProjectName(project)) {
            throw new BadRequestException('Invalid project name');
        }
    }

    // ─── Status / list / read ────────────────────────────────────────────

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersComposeStatus, {
        description: 'Whether the docker compose CLI is available and management is enabled.',
    })
    public dockerFoldersComposeStatus(): Promise<DockerFoldersComposeStatus> {
        return this.compose.getStatus();
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersComposeStack], { description: 'Every known Compose stack, with runtime status.' })
    public dockerFoldersComposeStacks(): Promise<DockerFoldersComposeStack[]> {
        return this.compose.getAllStacks();
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersComposeStack, { nullable: true, description: 'One stack by project name, or null.' })
    public async dockerFoldersComposeStack(
        @Args('project') project: string
    ): Promise<DockerFoldersComposeStack | null> {
        this.requireValidProjectName(project);
        return this.compose.getStack(project);
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersComposeFileContent, {
        description: 'The compose file on disk for a stack. Throws if the stack or file is missing.',
    })
    public dockerFoldersComposeFile(@Args('project') project: string): DockerFoldersComposeFileContent {
        this.requireValidProjectName(project);
        const result = this.compose.getComposeFileContent(project);
        if (!result.success || result.content === null) {
            throw new NotFoundException(result.error ?? 'Compose file not found');
        }
        return { content: result.content, path: result.path ?? '' };
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersComposeFileContent, {
        description: 'The env file on disk for a stack. An absent env file is not an error: content is "".',
    })
    public dockerFoldersComposeEnv(@Args('project') project: string): DockerFoldersComposeFileContent {
        this.requireValidProjectName(project);
        const result = this.compose.getEnvFileContent(project);
        if (!result.success) {
            throw new Error(result.error ?? 'Failed to read env file');
        }
        return { content: result.content ?? '', path: result.path ?? '' };
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersComposeFileVersion], { description: 'Version history for a stack\'s compose or env file.' })
    public dockerFoldersComposeFileVersions(
        @Args('project') project: string,
        @Args('fileType', { defaultValue: 'compose' }) fileType: string
    ): DockerFoldersComposeFileVersion[] {
        this.requireValidProjectName(project);
        const result = this.compose.getFileVersions(project, fileType);
        if (!result.success) throw new BadRequestException(result.error ?? 'Invalid file type');
        return result.versions.map(toFileVersion);
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersComposeFileVersionDetail, { description: 'One version\'s stored content. Throws if missing.' })
    public dockerFoldersComposeFileVersion(
        @Args('project') project: string,
        @Args('versionId', { type: () => Int }) versionId: number
    ): DockerFoldersComposeFileVersionDetail {
        this.requireValidProjectName(project);
        const result = this.compose.getFileVersionContent(project, versionId);
        if (!result.success || result.version === null) {
            throw new NotFoundException(result.error ?? 'Version not found');
        }
        return { ...toFileVersion(result.version), content: result.version.content };
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersComposeActionResult, { description: 'Combined stdout/stderr of `docker compose logs`.' })
    public async dockerFoldersComposeLogs(
        @Args('project') project: string,
        @Args('tail', { type: () => Int, defaultValue: 100 }) tail: number
    ): Promise<DockerFoldersComposeActionResult> {
        this.requireValidProjectName(project);
        return this.compose.stackLogs(project, tail);
    }

    /**
     * `docker compose logs --follow`, live, in place of polling
     * `dockerFoldersComposeLogs`. No `management_enabled` gate and the same
     * `READ_ANY` permission as that query — reading logs is not a management
     * action. `ComposeService.logStream` itself validates the project exactly
     * as `stackLogs` does (i.e. not at all beyond what `docker compose` itself
     * rejects); this resolver's own `requireValidProjectName` boundary check
     * (no PHP equivalent — `compose-stream.php` never gained a log-streaming
     * action) is the only shape validation for this one.
     *
     * The first chunk carries the initial `--tail` backlog; later chunks are
     * text to append, oldest-first (see `DockerFoldersComposeLogChunk`).
     * Unsubscribing (tab closed, connection dropped) kills the `docker
     * compose logs` child process — unlike `dockerFoldersComposeStream`, this
     * has no PHP `ignore_user_abort` precedent to match, because PHP never
     * had a live log stream; there is nothing to keep running on behalf of a
     * client that is no longer listening.
     */
    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Subscription(() => DockerFoldersComposeLogChunk, {
        description:
            'Live `docker compose logs --follow` output for a stack, replacing 3s polling of ' +
            'dockerFoldersComposeLogs. First chunk is the initial tail; later chunks are appended ' +
            'text, oldest-first. No management gate. Ends when the compose process exits.',
    })
    public dockerFoldersComposeLogStream(
        @Args('project') project: string,
        @Args('tail', { type: () => Int, defaultValue: 100 }) tail: number
    ): AsyncIterableIterator<{ dockerFoldersComposeLogStream: DockerFoldersComposeLogChunk }> {
        this.requireValidProjectName(project);
        return observableToAsyncIterator(
            mapObservable(this.compose.logStream(project, tail), (output) => ({
                dockerFoldersComposeLogStream: { output },
            }))
        );
    }

    // ─── Mutations with no management gate ──────────────────────────────

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeInstallResult, { description: 'Download and install the docker compose CLI plugin.' })
    public async installDockerFoldersComposeBinary(): Promise<{
        success: boolean;
        error: string | null;
        status: DockerFoldersComposeStatus | null;
    }> {
        const result = await this.compose.installComposeBinary();
        return { ...result, status: result.success ? await this.compose.getStatus() : null };
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeExportResult, { description: 'Copy every stack\'s compose/env files to a directory.' })
    public exportDockerFoldersComposeConfigs(
        @Args('exportDir', { nullable: true }) exportDir?: string
    ): DockerFoldersComposeExportResult {
        return this.compose.exportConfigs(exportDir ?? null);
    }

    @UsePermissions({ action: AuthAction.CREATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeCreateResult, { description: 'Create a new stack, its files, and its folder.' })
    public createDockerFoldersComposeStack(
        @Args('input') input: DockerFoldersComposeCreateInput
    ): DockerFoldersComposeCreateResult {
        const result = this.compose.createStack(input.projectName, input.composeContent ?? '', input.envContent ?? '');
        if (result.success) {
            // `api/compose.php`'s create branch publishes both of these
            // unconditionally on success (lines ~176-177), regardless of
            // whether `createStack` found an existing folder to reuse.
            // `folder`/`updated` names the PHP entity `folders` translated
            // through this codebase's established fix for that entity not
            // matching the frontend's dispatch table (see
            // `container.service.ts`'s `remove()` comment) — it may be a
            // redundant second signal when `FolderService.createFolder`
            // already published `folder`/`create` moments earlier, which is
            // harmless: both just mean "refetch folders".
            this.events.publish('compose', 'create');
            this.events.publish('folder', 'updated');
        }
        return result;
    }

    @UsePermissions({ action: AuthAction.CREATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeImportResult, { description: 'Import stacks from dcflachs/compose_plugin.' })
    public importDockerFoldersComposeStacks(): DockerFoldersComposeImportResult {
        const result = this.compose.importFromComposePlugin();
        if (result.stacksImported > 0) {
            this.events.publish('compose', 'import');
        }
        return result;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeValidateResult, { description: 'Validate a compose file via `docker compose config`.' })
    public validateDockerFoldersComposeContent(
        @Args('project') project: string,
        @Args('content', { nullable: true }) content?: string
    ): Promise<DockerFoldersComposeValidateResult> {
        this.requireValidProjectName(project);
        return this.compose.validateComposeContent(project, content ?? null);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Set a stack\'s description. Not gated on management being enabled — see the class doc.' })
    public setDockerFoldersComposeDescription(
        @Args('project') project: string,
        @Args('description') description: string
    ): boolean {
        this.requireValidProjectName(project);
        this.compose.setDescription(project, description);
        return true;
    }

    // ─── Mutations gated on management_enabled ──────────────────────────

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeActionResult, { description: '`docker compose up -d`. Answers success:false on failure rather than throwing.' })
    public async bringUpDockerFoldersComposeStack(
        @Args('project') project: string,
        @Args('forceRecreate', { nullable: true }) forceRecreate?: boolean
    ): Promise<DockerFoldersComposeActionResult> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = await this.compose.stackUp(project, forceRecreate === true);
        this.events.publish('compose', 'up');
        return result;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeActionResult, { description: '`docker compose down`.' })
    public async bringDownDockerFoldersComposeStack(
        @Args('project') project: string
    ): Promise<DockerFoldersComposeActionResult> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = await this.compose.stackDown(project);
        this.events.publish('compose', 'down');
        return result;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeActionResult, { description: '`docker compose stop` — halts containers without removing them.' })
    public async stopDockerFoldersComposeStack(
        @Args('project') project: string
    ): Promise<DockerFoldersComposeActionResult> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = await this.compose.stackStop(project);
        this.events.publish('compose', 'stop');
        return result;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeActionResult, { description: '`docker compose down` then `up -d`.' })
    public async restartDockerFoldersComposeStack(
        @Args('project') project: string
    ): Promise<DockerFoldersComposeActionResult> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = await this.compose.stackRestart(project);
        this.events.publish('compose', 'restart');
        return result;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeActionResult, { description: '`docker compose pull`.' })
    public async pullDockerFoldersComposeStack(
        @Args('project') project: string
    ): Promise<DockerFoldersComposeActionResult> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = await this.compose.stackPull(project);
        this.events.publish('compose', 'pull');
        return result;
    }

    /**
     * `compose-stream.php` as a subscription instead of an SSE response.
     * `action` is `'up'` (pull then `up -d`, `forceRecreate` adding
     * `--force-recreate`) or `'pull'` (pull only, `forceRecreate` ignored —
     * `ComposeService.streamStackPull` takes no such argument, matching PHP's
     * own `pull` branch never reading `force_recreate`).
     *
     * Validation order matches `compose-stream.php` exactly: action, then the
     * project-name check, then `management_enabled` — all three synchronous
     * or `await`ed before any Observable is created, so a refusal on any of
     * them rejects this subscribe call rather than emitting an `error` event
     * on the stream. The project check is `isValidProjectName` from
     * `ComposeService` (not `safeProjectName`, which rejects dots that this
     * rule and PHP both allow) — checked here too, even though
     * `streamStackUp`/`streamStackPull` re-check it, so the order is
     * observable independent of what those methods happen to validate first.
     * Called directly here, NOT through `requireValidProjectName`: unlike
     * every other action on this resolver, `compose-stream.php` rejects an
     * empty project (`!$project`) before ever reaching the name-shape check,
     * so an empty project must fail here too, not be skipped.
     *
     * Same not-tied-to-unsubscribe behavior as the two service methods: the
     * compose run keeps going after this subscription is dropped, matching
     * `compose-stream.php`'s `ignore_user_abort(true)`.
     *
     * Publishes `compose/{action}` when (and only when) the stream reaches
     * its `'complete'` event — `compose-stream.php` only calls
     * `WebSocketPublisher::publish()` inside `if ($result['success'])`, never
     * on the `'error'` branch. The publish happens as a side effect of
     * mapping that one event, not after the whole Observable completes,
     * since 'complete' is not itself the final event (`'done'` still
     * follows it).
     */
    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Subscription(() => DockerFoldersStreamEvent, {
        description:
            'Live output for `docker compose up`/`pull`, as compose-stream.php would stream over ' +
            'SSE — same event names and data fields, wrapped as {event, data} with data JSON-encoded. ' +
            'Refuses when the action or project name is invalid, or compose management is disabled. ' +
            'Keeps running after this subscription is dropped.',
    })
    public async dockerFoldersComposeStream(
        @Args('project') project: string,
        @Args('action') action: string,
        @Args('forceRecreate', { nullable: true }) forceRecreate?: boolean
    ): Promise<AsyncIterableIterator<{ dockerFoldersComposeStream: DockerFoldersStreamEvent }>> {
        if (action !== 'up' && action !== 'pull') {
            throw new BadRequestException('action must be "up" or "pull"');
        }
        if (!isValidProjectName(project)) {
            throw new BadRequestException('Invalid project name');
        }

        await this.requireManagementEnabled();

        const events$ = mapObservable(
            action === 'up'
                ? this.compose.streamStackUp(project, forceRecreate === true)
                : this.compose.streamStackPull(project),
            (event) => {
                if (event.type === 'complete') {
                    this.events.publish('compose', action);
                }
                return { dockerFoldersComposeStream: toStreamEvent(event) };
            }
        );
        return observableToAsyncIterator(events$);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeFileContent, { description: 'Overwrite the compose file, snapshotting the previous version.' })
    public async saveDockerFoldersComposeFile(
        @Args('project') project: string,
        @Args('content') content: string
    ): Promise<DockerFoldersComposeFileContent> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = this.compose.saveComposeFileContent(project, content);
        if (!result.success) throw new Error(result.error ?? 'Failed to save compose file');
        this.events.publish('compose', 'save_file');
        return { content, path: result.path ?? '' };
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeFileContent, { description: 'Overwrite the env file, snapshotting the previous version.' })
    public async saveDockerFoldersComposeEnv(
        @Args('project') project: string,
        @Args('content') content: string
    ): Promise<DockerFoldersComposeFileContent> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        const result = this.compose.saveEnvFileContent(project, content);
        if (!result.success) throw new Error(result.error ?? 'Failed to save env file');
        this.events.publish('compose', 'save_env');
        return { content, path: result.path ?? '' };
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersComposeFileContent, { description: 'Restore a compose or env file to a previous version.' })
    public async restoreDockerFoldersComposeFileVersion(
        @Args('project') project: string,
        @Args('versionId', { type: () => Int }) versionId: number
    ): Promise<DockerFoldersComposeFileContent> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();

        // Read the version's content before restoring it, so the answer can
        // echo back what was written without re-reading the file afterward
        // and having to guess whether it was the compose or the env file.
        const version = this.compose.getFileVersionContent(project, versionId);
        if (!version.success || version.version === null) {
            throw new NotFoundException(version.error ?? 'Version not found');
        }

        const result = this.compose.restoreFileVersion(project, versionId);
        if (!result.success) throw new Error(result.error ?? 'Failed to restore version');

        this.events.publish('compose', 'restore_version');
        return { content: version.version.content, path: result.path ?? '' };
    }

    /**
     * `set_env_path`. Boundary validation, ported exactly from
     * `api/compose.php`'s `set_env_path` branch (the comment there is the
     * canonical explanation, reproduced here): validated at the resolver
     * rather than inside `ComposeService`, because `ComposeService.setEnvFilePath`
     * (via the ported `upsertComposeStack` in `FolderService`) is also
     * reached from the container-list sync with a label-derived
     * `working_dir` that legitimately points anywhere on the box — a
     * containment check inside the service would break the container list
     * for genuine stacks. An empty path means "revert to the default `.env`
     * in working_dir".
     */
    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Set (or clear) the env file path for a stack.' })
    public async setDockerFoldersComposeEnvPath(
        @Args('project') project: string,
        @Args('path') path: string
    ): Promise<boolean> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();

        const requested = path.trim();
        const workingDir = this.compose.getStackWorkingDir(project);

        let pathToStore: string | null;
        if (requested === '') {
            pathToStore = null;
        } else {
            const resolved = resolveAgainst(requested, workingDir);
            if (resolved === null) {
                throw new BadRequestException(
                    'This stack has no working directory, so a relative env file path cannot be resolved. Use an absolute path.'
                );
            }

            const allowedRoots = [...composeAllowedRoots(this.paths)];
            if (workingDir) allowedRoots.push(workingDir);

            if (!pathIsWithinAny(resolved, allowedRoots)) {
                throw new BadRequestException('Env file path must be inside the stack directory or under /mnt');
            }

            pathToStore = resolved;
        }

        this.compose.setEnvFilePath(project, pathToStore);
        this.events.publish('compose', 'set_env_path');
        return true;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Enable/disable autostart for a stack.' })
    public async setDockerFoldersComposeAutostart(
        @Args('project') project: string,
        @Args('input') input: DockerFoldersComposeAutostartInput
    ): Promise<boolean> {
        this.requireValidProjectName(project);
        await this.requireManagementEnabled();
        this.compose.setAutostart(project, input.enabled, input.forceRecreate === true);
        this.events.publish('compose', 'autostart');
        return true;
    }

    /** `if (!$status['management_enabled']) errorResponse('Compose management is disabled...', 403)`. */
    private async requireManagementEnabled(): Promise<void> {
        const status = await this.compose.getStatus();
        if (!status.managementEnabled) {
            throw new ForbiddenException('Compose management is disabled (compose_plugin may be installed)');
        }
    }
}

function toFileVersion(row: { id: number; file_type: string; file_path: string; content_hash: string; created_at: number }): DockerFoldersComposeFileVersion {
    return {
        id: row.id,
        fileType: row.file_type,
        filePath: row.file_path,
        contentHash: row.content_hash,
        createdAt: row.created_at,
    };
}
