import { Args, Int, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { mapObservable, observableToAsyncIterator } from '../util/observable-to-async-iterator.js';
import { AdoptService } from './adopt.service.js';
import { AutostartService } from './autostart.service.js';
import { ContainerLogsService } from './container-logs.service.js';
import { ContainerStatsService } from './container-stats.service.js';
import type { DockerFoldersContainerStatsResult } from './container-stats.js';
import {
    DockerFoldersAdoptConfig,
    DockerFoldersAdoptField,
    DockerFoldersAdoptFields,
    DockerFoldersAutostartResult,
    DockerFoldersContainerLogs,
    DockerFoldersContainerStats,
    DockerFoldersContainerStatsEntry,
} from './container-extras.model.js';

/**
 * The four endpoints ported from `containers.php` and `stats.php` that are
 * not already covered by `ContainerListResolver` (the list itself) or
 * `ContainerResolver` (start/stop/restart/remove): logs, live stats,
 * autostart, and adopt fields.
 *
 * Every argument here is a plain scalar rather than an `@InputType` — none of
 * the four calls has a shape complex enough to need one, and a scalar `@Args`
 * needs no class-validator decorator for the API's global `ValidationPipe` to
 * accept it.
 */
@Resolver()
export class ContainerExtrasResolver {
    constructor(
        private readonly logs: ContainerLogsService,
        private readonly stats: ContainerStatsService,
        private readonly autostart: AutostartService,
        private readonly adopt: AdoptService
    ) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersContainerLogs, {
        description: "One container's log tail, newest line first.",
    })
    public dockerFoldersContainerLogs(
        @Args('id') id: string,
        @Args('tail', { type: () => Int, nullable: true, description: 'Clamped to 1-500; defaults to 50.' })
        tail?: number
    ): Promise<DockerFoldersContainerLogs> {
        return this.logs.getLogs(id, tail);
    }

    /**
     * The log tail, then each batch of new lines as the container writes
     * them, every batch in the query's shape (newest line first). Ends when
     * the container stops. See `ContainerLogsService.logStream`.
     */
    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Subscription(() => DockerFoldersContainerLogs, {
        description:
            "One container's log tail, then each batch of new lines as it is written, newest line first. Ends when the container stops.",
    })
    public dockerFoldersContainerLogStream(
        @Args('id') id: string,
        @Args('tail', { type: () => Int, nullable: true, description: 'Clamped to 1-500; defaults to 50.' })
        tail?: number
    ): AsyncIterableIterator<{ dockerFoldersContainerLogStream: DockerFoldersContainerLogs }> {
        return observableToAsyncIterator(
            mapObservable(this.logs.logStream(id, tail), (batch) => ({ dockerFoldersContainerLogStream: batch }))
        );
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersContainerStatsEntry], {
        description: 'Live CPU, memory, and I/O stats for the given container ids.',
    })
    public async dockerFoldersContainerStats(
        @Args('ids', { type: () => [String] }) ids: string[]
    ): Promise<DockerFoldersContainerStatsEntry[]> {
        return toStatsEntries(await this.stats.getStats(ids));
    }

    /**
     * The same readings as `dockerFoldersContainerStats`, pushed once at
     * subscribe time and then every `intervalMs` until the client
     * unsubscribes. The browser used to poll the query on its own timer; see
     * `ContainerStatsService.statsStream` for how the stream differs.
     */
    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Subscription(() => [DockerFoldersContainerStatsEntry], {
        description:
            'Live CPU, memory, and I/O stats for the given container ids, sent at once and then every intervalMs.',
    })
    public dockerFoldersContainerStatsStream(
        @Args('ids', { type: () => [String] }) ids: string[],
        @Args('intervalMs', {
            type: () => Int,
            nullable: true,
            description: 'Clamped to 1000-300000; defaults to 5000.',
        })
        intervalMs?: number
    ): AsyncIterableIterator<{ dockerFoldersContainerStatsStream: DockerFoldersContainerStatsEntry[] }> {
        return observableToAsyncIterator(
            mapObservable(this.stats.statsStream(ids, intervalMs ?? undefined), (results) => ({
                dockerFoldersContainerStatsStream: toStatsEntries(results),
            }))
        );
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersAdoptFields, {
        description:
            'Field set for handing a CLI-created container to /Docker/UpdateContainer. Read-only: nothing is written until the browser posts these fields to Unraid.',
    })
    public async dockerFoldersAdoptFields(@Args('id') id: string): Promise<DockerFoldersAdoptFields> {
        const result = await this.adopt.getAdoptFields(id);

        const fields: DockerFoldersAdoptField[] = Object.entries(result.fields).map(([key, value]) => ({
            key,
            value,
        }));

        // AdoptBuilder's `configs` use Unraid's own PascalCase XML attribute
        // names (Name, Target, Default, ...); the GraphQL type below spells
        // the same ten attributes lowercase, so they are remapped here rather
        // than in the pure builder, which stays a faithful port of the PHP
        // shape.
        const configs: DockerFoldersAdoptConfig[] = result.configs.map((config) => ({
            name: config.Name,
            target: config.Target,
            default: config.Default,
            mode: config.Mode,
            description: config.Description,
            type: config.Type,
            display: config.Display,
            required: config.Required,
            mask: config.Mask,
            value: config.Value,
        }));

        return { ...result, fields, configs };
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersAutostartResult, {
        description: "Toggle a container's autostart flag, and optionally its startup delay.",
    })
    public setDockerFoldersAutostart(
        @Args('name') name: string,
        @Args('enabled') enabled: boolean,
        @Args('delay', { type: () => Int, nullable: true }) delay?: number
    ): DockerFoldersAutostartResult {
        return this.autostart.setAutostart(name, enabled, delay);
    }
}

function toStatsEntries(
    results: Map<string, DockerFoldersContainerStatsResult | null>
): DockerFoldersContainerStatsEntry[] {
    return [...results].map(([id, stats]) => ({ id, stats: stats as DockerFoldersContainerStats | null }));
}
