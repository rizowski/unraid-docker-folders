import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * The container list, as the frontend's `Container` interface needs it.
 *
 * Shaped to that interface rather than to Docker's, because both backends have
 * to satisfy one seam and PHP got there first. Fields keep the spelling Docker
 * reports where they pass straight through.
 *
 * Every type here carries the `DockerFolders` prefix, and that is a hard
 * requirement rather than a naming preference. A plugin's types are merged
 * into the API's single code-first schema, so a name upstream already uses
 * fails the whole schema build with "Schema must contain uniquely named types
 * but contains multiple types named X" - and that does not disable the plugin,
 * it takes GraphQL down for the entire server. Measured on 4.35.1 with a type
 * called `DockerContainer`, which upstream also defines.
 *
 * Two fields are maps in the REST shape - `labels` and `networkSettings` - and
 * GraphQL has no map type. They are lists of pairs here rather than a JSON
 * scalar, so the schema still says what is in them and the plugin needs no
 * extra dependency. The frontend adapter rebuilds the objects.
 */

@ObjectType()
export class DockerFoldersPort {
    @Field(() => String, { nullable: true })
    ip?: string | null;

    @Field(() => Int)
    privatePort!: number;

    @Field(() => Int, { nullable: true, description: 'Absent until Docker publishes the port.' })
    publicPort?: number | null;

    @Field(() => String)
    type!: string;
}

/**
 * A published port binding, from `docker inspect`.
 *
 * Separate from `DockerFoldersPort` because it answers a different question: this is
 * what the container asked for, which survives the container being stopped,
 * where Docker's list response drops the public port entirely.
 */
@ObjectType()
export class DockerFoldersHostPort {
    @Field(() => String)
    hostIp!: string;

    @Field(() => Int)
    hostPort!: number;

    @Field(() => Int)
    containerPort!: number;

    @Field(() => String)
    type!: string;
}

@ObjectType()
export class DockerFoldersMount {
    @Field(() => String)
    type!: string;

    @Field(() => String)
    source!: string;

    @Field(() => String)
    destination!: string;

    @Field(() => Boolean, { description: 'False for a read-only mount.' })
    rw!: boolean;
}

@ObjectType({ description: 'One entry of a map GraphQL cannot express directly.' })
export class DockerFoldersLabel {
    @Field(() => String)
    key!: string;

    @Field(() => String)
    value!: string;
}

@ObjectType()
export class DockerFoldersNetwork {
    @Field(() => String, { description: 'The network name.' })
    name!: string;

    @Field(() => String, { description: 'Empty while the container is stopped.' })
    ipAddress!: string;
}

@ObjectType()
export class DockerFoldersContainer {
    @Field(() => String)
    id!: string;

    @Field(() => String)
    name!: string;

    @Field(() => String, {
        description: 'Resolved through the Unraid template, so it is a tag rather than a digest.',
    })
    image!: string;

    @Field(() => String)
    state!: string;

    @Field(() => String, { description: "Docker's human summary, such as 'Up 3 hours'." })
    status!: string;

    @Field(() => String)
    command!: string;

    @Field(() => Int, { description: 'Unix seconds.' })
    created!: number;

    @Field(() => [DockerFoldersPort])
    ports!: DockerFoldersPort[];

    @Field(() => [DockerFoldersHostPort], {
        description: 'Published bindings, present even when the container is stopped.',
    })
    hostPorts!: DockerFoldersHostPort[];

    @Field(() => [DockerFoldersMount])
    mounts!: DockerFoldersMount[];

    @Field(() => [DockerFoldersNetwork])
    networkSettings!: DockerFoldersNetwork[];

    @Field(() => String, { description: "HostConfig.NetworkMode, such as 'bridge' or 'host'." })
    networkMode!: string;

    @Field(() => Boolean)
    privileged!: boolean;

    @Field(() => [String])
    capAdd!: string[];

    @Field(() => [String], { description: "Config.ExposedPorts keys, in Docker's '8989/tcp' form." })
    exposedPorts!: string[];

    @Field(() => String, {
        description:
            "Config.User. A value can come from the image's own USER, so it only means somebody chose the user when it differs from imageUser.",
    })
    user!: string;

    @Field(() => String, { description: 'Config.User of the image, so user can be read as an override.' })
    imageUser!: string;

    @Field(() => String, { description: 'PUID from Config.Env. On Unraid this decides who owns written files.' })
    puid!: string;

    @Field(() => String)
    pgid!: string;

    @Field(() => String, { description: 'UMASK from Config.Env.' })
    umask!: string;

    @Field(() => [DockerFoldersLabel])
    labels!: DockerFoldersLabel[];

    @Field(() => String, { nullable: true })
    icon!: string | null;

    @Field(() => String, { nullable: true })
    managed!: string | null;

    @Field(() => String, { nullable: true })
    webui!: string | null;

    @Field(() => Boolean)
    autostart!: boolean;

    @Field(() => Int, { description: 'Seconds Unraid waits before starting this one. 0 when unset.' })
    autostartDelay!: number;
}

/** A security finding the user accepted. Keyed by name, so it survives a recreate. */
@ObjectType()
export class DockerFoldersDismissal {
    @Field(() => String)
    containerName!: string;

    @Field(() => String)
    findingType!: string;
}

@ObjectType()
export class DockerFoldersContainerList {
    @Field(() => [DockerFoldersContainer])
    containers!: DockerFoldersContainer[];

    @Field(() => [DockerFoldersDismissal])
    dismissals!: DockerFoldersDismissal[];
}
