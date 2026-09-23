import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

/**
 * A container's membership in a folder.
 *
 * Membership is keyed on the container name, not its id: Unraid recreates a
 * container on every template edit and the id changes with it. `containerId`
 * is the last id seen, carried for callers that want it.
 */
@ObjectType()
export class DockerFolderMember {
    @Field(() => Int)
    id!: number;

    @Field(() => String)
    containerId!: string;

    @Field(() => String)
    containerName!: string;

    @Field(() => Int, { description: 'Order within the folder, for manual sort' })
    position!: number;
}

@ObjectType()
export class DockerFolder {
    @Field(() => Int)
    id!: number;

    @Field(() => String)
    name!: string;

    @Field(() => String, {
        nullable: true,
        description: 'Either a FontAwesome name or stroke path data joined by "|"',
    })
    icon!: string | null;

    @Field(() => String, { nullable: true, description: 'CSS color, as stored' })
    color!: string | null;

    @Field(() => Int)
    position!: number;

    @Field(() => Boolean)
    collapsed!: boolean;

    @Field(() => String, {
        nullable: true,
        description: 'Set when the folder mirrors a Compose project',
    })
    composeProject!: string | null;

    @Field(() => String, { description: 'manual, name-asc, name-desc, status, created-asc or created-desc' })
    sortMode!: string;

    @Field(() => Int, { description: 'Unix seconds' })
    createdAt!: number;

    @Field(() => Int, { description: 'Unix seconds' })
    updatedAt!: number;

    @Field(() => [DockerFolderMember])
    containers!: DockerFolderMember[];
}

/** Everything the Folders view needs in one round trip. */
@ObjectType()
export class DockerFolderLayout {
    @Field(() => [DockerFolder])
    folders!: DockerFolder[];

    @Field(() => [String], {
        description: 'Names of containers outside any folder, in their manual order',
    })
    unfolderedOrder!: string[];
}

/**
 * What the frontend probes before committing to GraphQL mode. A plugin can be
 * installed and silently not loaded, and safe mode disables plugin loading
 * outright, so the probe has to prove the resolver answers and the database
 * is readable.
 */
@ObjectType()
export class DockerFoldersInfo {
    @Field(() => String)
    version!: string;

    @Field(() => String)
    databasePath!: string;

    @Field(() => Boolean)
    databaseReadable!: boolean;
}

/**
 * The sort modes `config.php` accepts. A mode outside this list falls back to
 * `manual`, matching `FolderManager::createFolder`.
 */
export const SORT_MODES = [
    'manual',
    'name-asc',
    'name-desc',
    'status',
    'created-asc',
    'created-desc',
] as const;

/**
 * Every field needs a class-validator decorator as well as `@Field`.
 *
 * The API installs a global ValidationPipe with `whitelist: true` and
 * `forbidNonWhitelisted: true` (`api/src/unraid-api/main.ts`). Whitelisting
 * keeps only the properties that carry a validation decorator, and forbidding
 * the rest turns anything else into a 400. A `@Field` alone is invisible to
 * it, so an input declared only for GraphQL is rejected property by property:
 * "property name should not exist". Seen on tower, where every folder write
 * in GraphQL mode failed this way.
 */
@InputType()
export class DockerFolderCreateInput {
    // No schema default: `createFolder` owns it, because it also has to cover
    // an explicit null and is called directly by the tests.
    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    name?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    icon?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    color?: string;

    @Field(() => String, { nullable: true, description: 'Set when the folder mirrors a Compose project' })
    @IsOptional()
    @IsString()
    composeProject?: string;

    @Field(() => String, { nullable: true, description: 'Anything not in SORT_MODES becomes manual' })
    @IsOptional()
    @IsString()
    sortMode?: string;
}

/**
 * Every field is optional and an omitted one leaves the column alone.
 *
 * A null is treated the same as an omission, which matches PHP: its handlers
 * use `isset()`, so a null never reaches an UPDATE either. Clearing an icon or
 * a color is therefore not possible in either backend, and this is not the
 * place to change that.
 */
@InputType()
export class DockerFolderUpdateInput {
    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    name?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    icon?: string;

    @Field(() => String, { nullable: true })
    @IsOptional()
    @IsString()
    color?: string;

    @Field(() => Int, { nullable: true })
    @IsOptional()
    @IsInt()
    position?: number;

    @Field(() => Boolean, { nullable: true })
    @IsOptional()
    @IsBoolean()
    collapsed?: boolean;

    @Field(() => String, { nullable: true, description: 'Ignored unless it is one of SORT_MODES' })
    @IsOptional()
    @IsString()
    sortMode?: string;
}

@ObjectType()
export class DockerFoldersImportResult {
    @Field(() => Boolean) success!: boolean;
    @Field(() => Int) foldersCreated!: number;
    @Field(() => Int) containersAssigned!: number;
    @Field(() => [String]) errors!: string[];
}
