import { Args, Field, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { PathBrowserService } from './path-browser.service.js';

@ObjectType()
export class DockerFoldersPathEntry {
    @Field(() => String) name!: string;
    @Field(() => String) path!: string;
}

@ObjectType()
export class DockerFoldersPathSuggestions {
    @Field(() => String, { description: 'The directory being listed, or empty at the top level.' })
    base!: string;

    @Field(() => [DockerFoldersPathEntry])
    entries!: DockerFoldersPathEntry[];

    @Field(() => Boolean, { description: 'Whether that directory holds a SQLite database.' })
    hasSqlite!: boolean;
}

/** The backup forms' path completion, ported from `api/paths.php`. */
@Resolver()
export class PathBrowserResolver {
    constructor(private readonly paths: PathBrowserService) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersPathSuggestions, {
        description: "Complete a path on the server ('host') or inside a container ('container').",
    })
    public async dockerFoldersPathSuggestions(
        @Args('scope', { type: () => String, nullable: true }) scope?: string,
        @Args('path', { type: () => String, nullable: true }) path?: string,
        @Args('container', { type: () => String, nullable: true }) container?: string,
        @Args('project', { type: () => String, nullable: true }) project?: string
    ): Promise<DockerFoldersPathSuggestions> {
        const result =
            scope === 'container'
                ? await this.paths.suggestContainerPaths(container ?? '', path ?? '', project ?? '')
                : this.paths.suggestHostPaths(path ?? '');
        return { base: result.base, entries: result.entries, hasSqlite: result.has_sqlite };
    }
}
