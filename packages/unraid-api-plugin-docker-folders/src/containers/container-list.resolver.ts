import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { FolderService } from '../folders/folder.service.js';
import { ContainerListService } from './container-list.service.js';
import { DockerFoldersContainerList } from './container.model.js';
import { SecurityService } from './security.service.js';

/**
 * The container list and the security dismissals that ride along with it.
 *
 * They answer together because the frontend needs both to render one screen,
 * and the PHP endpoint returns them in one body for the same reason. Splitting
 * them would make the page issue two requests to draw one list.
 */
@Resolver()
export class ContainerListResolver {
    constructor(
        private readonly containers: ContainerListService,
        private readonly security: SecurityService,
        private readonly folders: FolderService
    ) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersContainerList, {
        description: 'Every container, including stopped ones, with the accepted security findings.',
    })
    public async dockerFoldersContainerList(): Promise<DockerFoldersContainerList> {
        const containers = await this.containers.listContainers();

        // The same bookkeeping `containers.php` does on every list request:
        // reconcile ids after a recreate and file Compose containers into their
        // stack folder. Without it, switching the list to this backend would
        // quietly stop both. It is a write on a read path, which CLAUDE.md
        // records as a known gap; it is kept here rather than fixed so the two
        // backends leave the database in the same state.
        this.folders.syncWithContainers(
            containers.map((container) => ({
                id: container.id,
                name: container.name,
                labels: Object.fromEntries(container.labels.map((l) => [l.key, l.value])),
            }))
        );

        return { containers, dismissals: this.security.listDismissals() };
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Accept a security finding for a container.' })
    public dismissDockerFoldersFinding(
        @Args('containerName') containerName: string,
        @Args('findingType') findingType: string
    ): boolean {
        return this.security.dismiss(containerName, findingType);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Undo accepting a security finding.' })
    public restoreDockerFoldersFinding(
        @Args('containerName') containerName: string,
        @Args('findingType') findingType: string
    ): boolean {
        return this.security.restore(containerName, findingType);
    }
}
