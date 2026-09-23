import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

/**
 * GraphQL types for the four container endpoints ported from `containers.php`
 * and `stats.php`: logs, live stats, autostart, and adopt fields.
 *
 * Every type here carries the `DockerFolders` prefix — see `container.model.ts`
 * for why that is a hard requirement rather than a naming preference.
 *
 * Byte-count fields (`memoryUsage`, `memoryLimit`, `blockRead`, `blockWrite`,
 * `netRx`, `netTx`, `imageSize`, `logSize`) are `Float`, not `Int`. GraphQL's
 * `Int` is a 32-bit signed integer; a memory limit or an image size routinely
 * exceeds 2^31 (2 GiB) on a real box, and graphql-js throws on serializing an
 * out-of-range `Int` rather than silently truncating it. `Int` is kept only
 * for values that cannot plausibly reach that range: `pids`, `restartCount`,
 * `autostartDelay`.
 */

@ObjectType({
    description:
        "One container's log tail. `error`/`message` mirror containers.php's HTTP-200 error envelope: a Docker-refused read (an unreadable logging driver, a missing container) is reported here, not thrown, so a log pane polling on a timer does not fail a request every tick.",
})
export class DockerFoldersContainerLogs {
    @Field(() => String)
    logs!: string;

    @Field(() => Boolean)
    error!: boolean;

    @Field(() => String, { nullable: true })
    message!: string | null;
}

@ObjectType()
export class DockerFoldersContainerStats {
    @Field(() => Float)
    cpuPercent!: number;

    @Field(() => Float)
    memoryUsage!: number;

    @Field(() => Float)
    memoryLimit!: number;

    @Field(() => Float)
    memoryPercent!: number;

    @Field(() => Float)
    blockRead!: number;

    @Field(() => Float)
    blockWrite!: number;

    @Field(() => Float)
    netRx!: number;

    @Field(() => Float)
    netTx!: number;

    @Field(() => Int)
    pids!: number;

    @Field(() => Int)
    restartCount!: number;

    @Field(() => String)
    startedAt!: string;

    @Field(() => Float)
    imageSize!: number;

    @Field(() => Float)
    logSize!: number;
}

/**
 * One entry of the `{id: stats|null}` map `stats.php` answers with. A list of
 * pairs, not a JSON scalar, for the same reason `DockerFoldersLabel` is in
 * `container.model.ts`: GraphQL has no map type, and this keeps the schema
 * honest about the shape without an extra dependency. `stats` is nullable
 * because a stopped or just-removed container answers null, matching
 * `fetchBatchStats`'s `$output[$id] = null` branch.
 */
@ObjectType()
export class DockerFoldersContainerStatsEntry {
    @Field(() => String)
    id!: string;

    @Field(() => DockerFoldersContainerStats, { nullable: true })
    stats!: DockerFoldersContainerStats | null;
}

@ObjectType({ description: 'The result of toggling autostart, mirroring containers.php\'s response body.' })
export class DockerFoldersAutostartResult {
    @Field(() => Boolean)
    success!: boolean;

    @Field(() => Boolean)
    autostart!: boolean;

    @Field(() => Int, { nullable: true, description: 'Null when no delay was sent, matching the write that skips.' })
    autostartDelay!: number | null;
}

/** One `<Config>` mapping row. Field names match Unraid's own XML attribute names, lowercased for GraphQL. */
@ObjectType()
export class DockerFoldersAdoptConfig {
    @Field(() => String)
    name!: string;

    @Field(() => String)
    target!: string;

    @Field(() => String)
    default!: string;

    @Field(() => String)
    mode!: string;

    @Field(() => String)
    description!: string;

    @Field(() => String)
    type!: string;

    @Field(() => String)
    display!: string;

    @Field(() => String)
    required!: string;

    @Field(() => String)
    mask!: string;

    @Field(() => String)
    value!: string;
}

/** One `cont*` scalar field, e.g. `contName` / `Adopt2`. A map GraphQL cannot express directly. */
@ObjectType()
export class DockerFoldersAdoptField {
    @Field(() => String)
    key!: string;

    @Field(() => String)
    value!: string;
}

@ObjectType({
    description:
        'The field set for handing a CLI-created container to /Docker/UpdateContainer, ported from AdoptBuilder::build.',
})
export class DockerFoldersAdoptFields {
    @Field(() => [DockerFoldersAdoptField], { description: 'Every cont* scalar, including the empty ones — Unraid reads most of them without a null-coalesce.' })
    fields!: DockerFoldersAdoptField[];

    @Field(() => [DockerFoldersAdoptConfig])
    configs!: DockerFoldersAdoptConfig[];

    @Field(() => [String], { description: 'Settings that could not be expressed, for the preview to warn about.' })
    unmapped!: string[];

    @Field(() => Boolean, { description: 'False when the image could not be read, so the variable list is noisy.' })
    imageEnvKnown!: boolean;

    @Field(() => Boolean, { description: 'False when Unraid will pass ports as variables rather than publishing them.' })
    portsPublished!: boolean;

    @Field(() => String, { description: "bridge, macvlan, ipvlan, host — '' when it could not be determined." })
    networkDriver!: string;

    @Field(() => String, { nullable: true })
    managed!: string | null;
}
