import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { mapObservable, observableToAsyncIterator } from '../util/observable-to-async-iterator.js';
import { DockerFoldersStreamEvent, toStreamEvent } from '../streaming/stream-event.js';
import { DockerFoldersImagePullResult, DockerFoldersImageUpdateStatus } from './updates.model.js';
import { UpdatesService } from './updates.service.js';

/**
 * Image update checking and pulling, ported from `api/updates.php` and
 * `api/pull.php`. Every field is pure delegation; see `UpdatesService` for
 * what it does and what it deliberately does not.
 */
@Resolver()
export class UpdatesResolver {
    constructor(private readonly updates: UpdatesService) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersImageUpdateStatus], {
        description: 'Cached image update results, from the last check of any kind.',
    })
    public dockerFoldersImageUpdates(): DockerFoldersImageUpdateStatus[] {
        return this.updates.getCached();
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => [DockerFoldersImageUpdateStatus], {
        description:
            'Check container images for updates. With no images given, checks every running ' +
            "container's image; otherwise restricts the check to the given images.",
    })
    public checkDockerFoldersImageUpdates(
        @Args('images', { type: () => [String], nullable: true }) images?: string[]
    ): Promise<DockerFoldersImageUpdateStatus[]> {
        return this.updates.checkForUpdates(images ?? null);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersImagePullResult, {
        description:
            'Pull an image. With post_pull_action set to auto-recreate, or with recreate ' +
            'true, also recreates the containers using it (restricted to containerIds when given). ' +
            'For the same pull as a stream of progress events, see dockerFoldersImagePullEvents below.',
    })
    public pullDockerFoldersImage(
        @Args('image') image: string,
        @Args('containerIds', { type: () => [String], nullable: true })
        containerIds?: string[],
        @Args('recreate', { type: () => Boolean, nullable: true }) recreate?: boolean
    ): Promise<DockerFoldersImagePullResult> {
        return this.updates.pullImage(image, { containers: containerIds, recreate });
    }

    /**
     * `pull.php` as a subscription instead of an SSE response: every field
     * this resolver takes matches `pullDockerFoldersImage` above, and every
     * event this emits matches what `pull.php` would have sent — see
     * `pull-events.ts` and `UpdatesService.pullImageEvents` for the
     * event-by-event mapping. `image`/`containerIds`/`recreate` validation
     * throws synchronously from `pullImageEvents()` (invalid image name,
     * invalid container ids, or `recreate` without `containerIds`), which
     * surfaces as this subscribe call rejecting rather than as an event on
     * the stream — the same distinction PHP draws between its top-of-file
     * `errorResponse()` calls and its `sendSSE('error', ...)` calls.
     *
     * The pull keeps running to completion even if this subscription is
     * dropped (client unsubscribe, lost websocket) — see
     * `UpdatesService.pullImageEvents`'s doc for why: it mirrors `pull.php`'s
     * `ignore_user_abort(true)`, which keeps the PHP request (and the
     * recreate step after it) running after the browser disconnects.
     */
    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Subscription(() => DockerFoldersStreamEvent, {
        description:
            'Live progress for pulling an image, as pull.php would stream over SSE — same event ' +
            'names and data fields, wrapped as {event, data} with data JSON-encoded. Keeps running ' +
            'after this subscription is dropped; see pullDockerFoldersImage for the plain mutation.',
    })
    public dockerFoldersImagePullEvents(
        @Args('image') image: string,
        @Args('containerIds', { type: () => [String], nullable: true })
        containerIds?: string[],
        @Args('recreate', { type: () => Boolean, nullable: true }) recreate?: boolean
    ): AsyncIterableIterator<{ dockerFoldersImagePullEvents: DockerFoldersStreamEvent }> {
        const events$ = mapObservable(
            this.updates.pullImageEvents(image, { containers: containerIds, recreate }),
            (event) => ({ dockerFoldersImagePullEvents: toStreamEvent(event) })
        );
        return observableToAsyncIterator(events$);
    }
}
