import { Args, Mutation, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { ContainerService } from './container.service.js';

/**
 * The container actions the plugin owns. See `ContainerService` for why these
 * are not calls to upstream's `docker.mutations`.
 *
 * The id argument is a plain String, not upstream's `PrefixedID`. This is our
 * schema, and the frontend already holds the bare Docker id it got from
 * `containers.php`. Upstream's scalar would accept it unchanged either way:
 * `parseValue` only strips a prefix when the value splits on a colon into
 * exactly two parts, and a Docker id has no colon.
 *
 * Each field answers `true`, because that is all the store reads before it
 * refetches. A failure throws, and the frontend reads the message off the
 * GraphQL error the same way it reads PHP's error body.
 */
@Resolver()
export class ContainerResolver {
    constructor(private readonly containers: ContainerService) {}

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, {
        description: 'Start a container, or resume it when it is paused.',
    })
    public startDockerContainer(@Args('id') id: string): Promise<boolean> {
        return this.containers.start(id);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Resume a paused container.' })
    public resumeDockerContainer(@Args('id') id: string): Promise<boolean> {
        return this.containers.resume(id);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Stop a container, allowing 10 seconds to exit.' })
    public stopDockerContainer(@Args('id') id: string): Promise<boolean> {
        return this.containers.stop(id);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Restart a container, allowing 10 seconds to exit.' })
    public restartDockerContainer(@Args('id') id: string): Promise<boolean> {
        return this.containers.restart(id);
    }

    @UsePermissions({ action: AuthAction.DELETE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, {
        description:
            'Remove a stopped container and its folder membership, and optionally its image.',
    })
    public removeDockerContainer(
        @Args('id') id: string,
        @Args('removeImage', { type: () => Boolean, nullable: true }) removeImage?: boolean
    ): Promise<boolean> {
        return this.containers.remove(id, removeImage === true);
    }
}
