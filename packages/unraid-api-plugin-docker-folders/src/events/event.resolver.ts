import { Inject } from '@nestjs/common';
import { Resolver, Subscription } from '@nestjs/graphql';
import type { PubSubEngine } from 'graphql-subscriptions';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { GRAPHQL_PUBSUB_TOKEN } from '@unraid/shared/pubsub/graphql.pubsub.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { DOCKER_FOLDERS_EVENT_TOPIC, DockerFoldersEvent } from './event.model.js';

/**
 * The live-update channel, and the replacement for nchan.
 *
 * A client needs `connectionParams: { 'x-csrf-token': <token> }` on the
 * websocket. Verified on Unraid 7.3.2 / API 4.35.1: with no connection
 * parameters, and with an empty object, a subscribe fails with "Cannot read
 * properties of undefined (reading 'csrf_token')". The guard runs per
 * operation, so a `connection_ack` alone says nothing about whether the
 * subscription is allowed. The session cookie rides the upgrade request, which
 * the browser sends by itself.
 */
@Resolver()
export class EventResolver {
    constructor(@Inject(GRAPHQL_PUBSUB_TOKEN) private readonly pubsub: PubSubEngine) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Subscription(() => DockerFoldersEvent, {
        description:
            'Fires when containers or folders change, including changes made outside the plugin.',
    })
    public dockerFoldersEvents() {
        return this.pubsub.asyncIterableIterator<{ dockerFoldersEvents: DockerFoldersEvent }>(
            DOCKER_FOLDERS_EVENT_TOPIC
        );
    }
}
