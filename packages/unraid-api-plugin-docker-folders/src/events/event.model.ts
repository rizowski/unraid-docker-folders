import { Field, Int, ObjectType } from '@nestjs/graphql';

/**
 * What a live update carries.
 *
 * The same three fields the nchan payload carries, and for the same reason:
 * every event is a "refetch this entity" signal rather than a patch. The
 * frontend has always worked that way, and keeping the shape identical is
 * what lets one dispatch table serve both transports.
 *
 * There is deliberately no `data` field. nchan sends `data: null`, and adding
 * a payload here would make the two transports disagree about how much a
 * client may rely on an event, which is exactly the divergence the two-backend
 * period is supposed to avoid.
 */
@ObjectType()
export class DockerFoldersEvent {
    @Field(() => String, {
        description:
            'Which kind of thing changed: container, folder, compose, schedules or updates.',
    })
    entity!: string;

    @Field(() => String, { description: 'What happened to it, for diagnostics.' })
    action!: string;

    @Field(() => Int, { description: 'Unix seconds, matching what the PHP publisher sends.' })
    timestamp!: number;
}

/**
 * The pubsub topic the plugin publishes on.
 *
 * Not a `GRAPHQL_PUBSUB_CHANNEL` value. That enum is upstream's, a plugin
 * cannot extend it, and publishing on one of its members would put our events
 * on a channel upstream also uses. The bus keys on a plain string, so a
 * namespaced one of our own keeps the two apart.
 */
export const DOCKER_FOLDERS_EVENT_TOPIC = 'unraid-docker-folders/events';
