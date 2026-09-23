import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { PubSubEngine } from 'graphql-subscriptions';

import { GRAPHQL_PUBSUB_TOKEN } from '@unraid/shared/pubsub/graphql.pubsub.js';

import { nowSeconds } from '../util/time.js';
import { DOCKER_FOLDERS_EVENT_TOPIC, DockerFoldersEvent } from './event.model.js';
import { NchanService } from './nchan.service.js';

/**
 * One call site for "something changed", fanned out to both transports.
 *
 * Every mutation calls this rather than either transport directly. A
 * GraphQL-mode page listens only to the subscription. nchan is still fed for
 * a tab that is in PHP mode, for example one that fell back to PHP when the
 * plugin did not answer, or one opened before the mode changed.
 *
 * Neither publish can fail a mutation: nchan is fire and forget by
 * construction, and the pubsub publish is a promise nobody awaits, so its
 * rejection is caught here rather than left unhandled.
 */
@Injectable()
export class EventBusService {
    private readonly logger = new Logger(EventBusService.name);

    constructor(
        private readonly nchan: NchanService,
        /**
         * Optional, because the CLI runs outside the GraphQL server and that
         * context provides no bus. `unraid-api docker-folders:status` only
         * reads, so it never reaches a publish, but Nest resolves the whole
         * dependency graph before any command runs. Optional here beats a
         * second stand-in class that would drift from this one.
         */
        @Optional() @Inject(GRAPHQL_PUBSUB_TOKEN) private readonly pubsub: PubSubEngine | null
    ) {}

    publish(entity: string, action: string): void {
        this.nchan.publish(entity, action);

        if (this.pubsub === null) return;

        const event: DockerFoldersEvent = { entity, action, timestamp: nowSeconds() };
        this.pubsub
            .publish(DOCKER_FOLDERS_EVENT_TOPIC, { dockerFoldersEvents: event })
            .catch((error: unknown) => {
                this.logger.warn(`Could not publish ${entity}/${action}: ${String(error)}`);
            });
    }
}
