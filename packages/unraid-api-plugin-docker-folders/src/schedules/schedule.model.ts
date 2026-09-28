import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Schedules over GraphQL.
 *
 * `backupConfigJson` is a JSON string rather than a typed object, and that is
 * the one place this schema gives up on types. Its `paths` field is either a
 * list of path strings or a list of `{service, patterns}` objects, depending
 * on whether the target is a container or a stack, and GraphQL has no way to
 * say "a list of one or the other". The column is JSON in the database anyway,
 * so the string is what is stored, and the frontend adapter parses it.
 *
 * Every type carries the `DockerFolders` prefix: a name upstream already uses
 * fails the whole server's schema.
 */

@ObjectType()
export class DockerFoldersSchedule {
    @Field(() => Int) id!: number;
    @Field(() => String) name!: string;
    @Field(() => String, { description: "'container' or 'stack'." }) targetType!: string;
    @Field(() => String, { description: 'A container name or a Compose project name.' }) targetId!: string;
    @Field(() => String) action!: string;
    @Field(() => String) cronExpression!: string;
    @Field(() => Boolean) enabled!: boolean;
    @Field(() => String, { nullable: true }) backupConfigJson!: string | null;
    @Field(() => Int, { nullable: true }) lastRunAt!: number | null;
    @Field(() => String, { nullable: true }) lastRunStatus!: string | null;
    @Field(() => String, { nullable: true }) lastRunMessage!: string | null;
    @Field(() => Int, { nullable: true }) nextRunAt!: number | null;
    @Field(() => Int) createdAt!: number;
    @Field(() => Int) updatedAt!: number;
}

@ObjectType()
export class DockerFoldersScheduleHistoryEntry {
    @Field(() => Int) id!: number;
    @Field(() => Int) scheduleId!: number;
    @Field(() => Int) startedAt!: number;
    @Field(() => Int, { nullable: true }) finishedAt!: number | null;
    @Field(() => String) status!: string;
    @Field(() => String, { nullable: true }) message!: string | null;
    @Field(() => String, { nullable: true }) backupFile!: string | null;
    // Float, because a backup can be larger than GraphQL's 32-bit Int.
    @Field(() => Number, { nullable: true }) backupSize!: number | null;
}

@ObjectType()
export class DockerFoldersScheduleRunner {
    @Field(() => Int, { nullable: true }) lastTick!: number | null;
    @Field(() => Boolean) stale!: boolean;
    @Field(() => Int) staleAfter!: number;
    @Field(() => Boolean) cronInstalled!: boolean;
    @Field(() => Boolean) repaired!: boolean;
}

@ObjectType()
export class DockerFoldersScheduleRun {
    @Field(() => Boolean) success!: boolean;
    @Field(() => Int) scheduleId!: number;
    @Field(() => String) status!: string;
    @Field(() => String) message!: string;
}

/**
 * Create and update share one input, with every field optional, as the PHP
 * endpoints share one body. Required fields are enforced by the service on
 * create, with the same messages PHP sends.
 *
 * Every property carries a class-validator decorator. The API's global
 * ValidationPipe rejects any property that does not.
 */
@InputType()
export class DockerFoldersScheduleInput {
    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    name?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsIn(['container', 'stack'])
    targetType?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    targetId?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsIn(['start', 'stop', 'pause', 'resume', 'restart', 'backup', 'update'])
    action?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    cronExpression?: string;

    @Field(() => Boolean, { nullable: true })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(100_000)
    backupConfigJson?: string;
}

@InputType()
export class DockerFoldersScheduleToggle {
    @Field(() => Int)
    @IsInt()
    id!: number;

    @Field(() => Boolean)
    @IsBoolean()
    enabled!: boolean;
}

/** What the backup form needs to offer Postgres mode. Never carries a password. */
@ObjectType()
export class DockerFoldersPostgresInfo {
    @Field(() => Boolean) isPostgres!: boolean;
    @Field(() => Boolean) running!: boolean;
    @Field(() => String) envUser!: string;
    @Field(() => Boolean) hasEnvPassword!: boolean;
}

@ObjectType()
export class DockerFoldersPostgresDatabases {
    @Field(() => Boolean) success!: boolean;
    @Field(() => [String]) databases!: string[];
    @Field(() => String) message!: string;
}

/** A container, or one compose service of a stack. */
@InputType()
export class DockerFoldersPostgresTargetInput {
    @Field(() => String)
    @IsIn(['container', 'stack'])
    targetType!: string;

    @Field(() => String)
    @IsString()
    @MaxLength(255)
    targetId!: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    service?: string;
}

/**
 * A mutation, not a query, because it can carry a password. With custom
 * credentials, scheduleId and no password, that schedule's saved password
 * is used.
 */
@InputType()
export class DockerFoldersPostgresDatabasesInput extends DockerFoldersPostgresTargetInput {
    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsIn(['env', 'custom'])
    credentials?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(63)
    user?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    @MaxLength(1024)
    password?: string;

    @Field(() => Int, { nullable: true })
    @IsOptional()
    @IsInt()
    scheduleId?: number;
}
