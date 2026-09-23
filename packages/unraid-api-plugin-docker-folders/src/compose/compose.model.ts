import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

/**
 * GraphQL types for Compose, ported from `ComposeManager.php` and the shapes
 * `api/compose.php` answers with (cross-checked against
 * `src/frontend/src/types/compose.ts` and the `compose` section of
 * `src/frontend/src/backends/types.ts`).
 *
 * Every type name is prefixed `DockerFolders` — a plugin name that collides
 * with one upstream already uses fails the whole server's schema, which has
 * already happened once on this project.
 */

@ObjectType()
export class DockerFoldersComposeStack {
    @Field(() => String)
    projectName!: string;

    @Field(() => String, { nullable: true })
    workingDir!: string | null;

    @Field(() => String, { nullable: true })
    composeFile!: string | null;

    @Field(() => String, { nullable: true })
    envFile!: string | null;

    @Field(() => Boolean)
    autostart!: boolean;

    @Field(() => Boolean)
    autostartForceRecreate!: boolean;

    @Field(() => String, { nullable: true })
    description!: string | null;

    @Field(() => String, { nullable: true, description: '"compose_plugin" when migrated from dcflachs/compose_plugin' })
    importedFrom!: string | null;

    @Field(() => Int)
    servicesRunning!: number;

    @Field(() => Int)
    servicesTotal!: number;

    @Field(() => [String], {
        description: 'Top-level service names from the compose file, even when the stack is fully down',
    })
    serviceNames!: string[];
}

@ObjectType()
export class DockerFoldersComposeStatus {
    @Field(() => Boolean)
    composeAvailable!: boolean;

    @Field(() => String, { nullable: true })
    composeVersion!: string | null;

    @Field(() => Boolean, { description: 'True when dcflachs/compose_plugin is also installed' })
    composePluginInstalled!: boolean;

    @Field(() => Boolean, { description: 'composeAvailable && !composePluginInstalled' })
    managementEnabled!: boolean;

    @Field(() => Boolean)
    composePluginDataExists!: boolean;
}

/** One problem `docker compose config` reported, positioned in the file. */
@ObjectType()
export class DockerFoldersComposeValidationError {
    @Field(() => Int)
    line!: number;

    @Field(() => Int, { nullable: true })
    column!: number | null;

    @Field(() => String)
    message!: string;
}

@ObjectType()
export class DockerFoldersComposeValidateResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => String)
    output!: string;

    @Field(() => [DockerFoldersComposeValidationError])
    errors!: DockerFoldersComposeValidationError[];
}

/**
 * What `up`/`down`/`stop`/`restart`/`pull`/`logs` answer with —
 * `ComposeManager::execCommand`'s result shape, unchanged whether the command
 * succeeded or not. A failed compose command is a value here, never a thrown
 * GraphQL error: `api/compose.php` answers these with HTTP 200 and
 * `success: false`, and the resolver preserves that rather than throwing.
 */
@ObjectType()
export class DockerFoldersComposeActionResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => String, { nullable: true })
    output!: string | null;

    @Field(() => String, { nullable: true })
    error!: string | null;

    @Field(() => Int, { nullable: true })
    exitCode!: number | null;
}

/**
 * One chunk out of `dockerFoldersComposeLogStream`. The first chunk holds the
 * initial `--tail` backlog; every later chunk is text to append, oldest-first
 * — same order `docker compose logs` itself prints in. Kept separate from
 * `DockerFoldersComposeActionResult` (which fits a single completed command,
 * not a running stream of partial output) even though both are one string
 * field, so the schema names what each is for.
 */
@ObjectType()
export class DockerFoldersComposeLogChunk {
    @Field(() => String)
    output!: string;
}

@ObjectType()
export class DockerFoldersComposeFileContent {
    @Field(() => String)
    content!: string;

    @Field(() => String)
    path!: string;
}

@ObjectType()
export class DockerFoldersComposeFileVersion {
    @Field(() => Int)
    id!: number;

    @Field(() => String, { description: '"compose" or "env"' })
    fileType!: string;

    @Field(() => String, { description: 'Relative to the stack working_dir, e.g. ".versions/172..-compose.yml"' })
    filePath!: string;

    @Field(() => String)
    contentHash!: string;

    @Field(() => Int, { description: 'Unix seconds' })
    createdAt!: number;
}

@ObjectType()
export class DockerFoldersComposeFileVersionDetail extends DockerFoldersComposeFileVersion {
    @Field(() => String)
    content!: string;
}

@ObjectType()
export class DockerFoldersComposeImportResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => Int)
    stacksImported!: number;

    @Field(() => Int)
    stacksSkipped!: number;

    @Field(() => [String])
    errors!: string[];
}

@ObjectType()
export class DockerFoldersComposeExportResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => String, { nullable: true })
    error!: string | null;

    @Field(() => Int, { nullable: true })
    exported!: number | null;

    @Field(() => [String])
    errors!: string[];

    @Field(() => String, { nullable: true })
    path!: string | null;
}

@ObjectType()
export class DockerFoldersComposeCreateResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => String, { nullable: true })
    error!: string | null;

    @Field(() => String, { nullable: true })
    projectName!: string | null;
}

@ObjectType()
export class DockerFoldersComposeInstallResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => String, { nullable: true })
    error!: string | null;

    @Field(() => DockerFoldersComposeStatus, { nullable: true })
    status!: DockerFoldersComposeStatus | null;
}

/**
 * Every field needs a class-validator decorator as well as `@Field`, or the
 * API's global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted:
 * true`) rejects the property outright. See `folder.model.ts` for the full
 * story.
 *
 * `projectName` is validated for real by `ComposeService.createStack` itself
 * (`safeProjectName`, matching where `ComposeManager::createStack` does it —
 * PHP places this check in the manager, not the API boundary, for this one
 * field). `@IsString` here only keeps a non-string out of the whitelist pass;
 * it is not the security boundary.
 */
@InputType()
export class DockerFoldersComposeCreateInput {
    @Field(() => String)
    @IsString()
    projectName!: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    composeContent?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    envContent?: string;
}

@InputType()
export class DockerFoldersComposeAutostartInput {
    @Field(() => Boolean)
    @IsBoolean()
    enabled!: boolean;

    @Field(() => Boolean, { nullable: true })
    @IsOptional()
    @IsBoolean()
    forceRecreate?: boolean;
}

/**
 * One event out of a live `up`/`pull` run — NOT a GraphQL type (no
 * `@ObjectType`). `ComposeService.streamStackUp`/`streamStackPull` expose
 * this as an RxJS `Observable` for whoever wires the GraphQL subscription
 * (out of scope here; see the report). Shaped after the SSE events
 * `compose-stream.php` sends (`sendSSE('phase'|'log'|'complete'|'error', ...)`
 * plus the initial `status` and terminal `done`), collapsed to one
 * discriminated union so a subscription resolver can map each variant to its
 * own SSE-equivalent event name.
 */
export interface DockerFoldersComposeStreamEvent {
    type: 'status' | 'phase' | 'log' | 'complete' | 'error' | 'done';
    /** Set on 'status', 'complete', and 'error'. */
    message?: string;
    /** Set on 'phase': 'pulling' | 'pull_warning' | 'starting'. */
    phase?: string;
    /** Set on 'log'. */
    line?: string;
    /** Set on 'log'. */
    stream?: 'out' | 'err';
    /** Set on 'status' and 'complete'. */
    project?: string;
    /** Set on 'done' — matches `compose-stream.php`'s final `sendSSE('done', ['finished' => true])`. */
    finished?: true;
}
