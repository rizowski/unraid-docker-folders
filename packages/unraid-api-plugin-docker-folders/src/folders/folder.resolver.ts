import { BadRequestException } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import {
    DockerFolder,
    DockerFolderCreateInput,
    DockerFolderLayout,
    DockerFolderUpdateInput,
    DockerFoldersImportResult,
    DockerFoldersInfo,
} from './folder.model.js';
import { FolderService } from './folder.service.js';

/**
 * Every field needs an explicit @UsePermissions or the API refuses to load the
 * plugin. `Resource` is upstream's enum and a plugin cannot extend it, so
 * these use the closest existing resource.
 *
 * Every field here is pure delegation. A mutation that names a folder which is
 * gone throws NotFoundException from the service, and the API turns that into
 * a GraphQL error whose message the frontend reads the same way it reads the
 * message out of PHP's 404 body.
 */
@Resolver()
export class FolderResolver {
    constructor(private readonly folderService: FolderService) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersInfo, {
        description: 'Probe: proves the plugin is loaded and its database is readable.',
    })
    public dockerFoldersInfo(): DockerFoldersInfo {
        return this.folderService.getInfo();
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFolderLayout, {
        description: 'Every folder with its members, plus the order of unfoldered containers.',
    })
    public dockerFolderLayout(): DockerFolderLayout {
        return this.folderService.getLayout();
    }

    @UsePermissions({ action: AuthAction.CREATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFolder, { description: 'Create a folder at the end of the list.' })
    public createDockerFolder(@Args('input') input: DockerFolderCreateInput): DockerFolder {
        return this.folderService.createFolder(input);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFolder, {
        description: 'Change a folder. An omitted field leaves its column alone.',
    })
    public updateDockerFolder(
        @Args('id', { type: () => Int }) id: number,
        @Args('input') input: DockerFolderUpdateInput
    ): DockerFolder {
        return this.folderService.updateFolder(id, input);
    }

    @UsePermissions({ action: AuthAction.DELETE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Delete a folder. Its containers become unfoldered.' })
    public deleteDockerFolder(@Args('id', { type: () => Int }) id: number): boolean {
        this.folderService.deleteFolder(id);
        return true;
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFolder, {
        description: 'Move a container into this folder, out of whichever one it was in.',
    })
    public addContainerToDockerFolder(
        @Args('folderId', { type: () => Int }) folderId: number,
        @Args('containerId') containerId: string,
        @Args('containerName') containerName: string
    ): DockerFolder {
        return this.folderService.addContainerToFolder(folderId, containerId, containerName);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, {
        description:
            'Take a container out of its folder, and keep the Compose sync from putting it back.',
    })
    public removeContainerFromDockerFolder(@Args('containerName') containerName: string): boolean {
        return this.folderService.removeContainerFromFolder(containerName);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFolder, {
        description: 'Set the manual order inside a folder, by container id, first to last.',
    })
    public reorderDockerFolderContainers(
        @Args('folderId', { type: () => Int }) folderId: number,
        @Args('containerIds', { type: () => [String] }) containerIds: string[]
    ): DockerFolder {
        return this.folderService.reorderContainers(folderId, containerIds);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Set the order of the folders themselves.' })
    public reorderDockerFolders(
        @Args('folderIds', { type: () => [Int] }) folderIds: number[]
    ): boolean {
        return this.folderService.reorderFolders(folderIds);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => [String], {
        description:
            'Replace the manual order of the containers in no folder. Send the whole list.',
    })
    public reorderUnfolderedDockerContainers(
        @Args('containerNames', { type: () => [String] }) containerNames: string[]
    ): string[] {
        return this.folderService.setUnfolderedOrder(containerNames);
    }

    /**
     * The export file, as JSON text. A string rather than a typed object
     * because it is a file format: the frontend saves it to disk as is, and
     * an older file has to import unchanged.
     */
    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => String, { description: 'Every folder and its members, as an export file.' })
    public dockerFoldersExport(): string {
        return JSON.stringify(this.folderService.exportConfiguration());
    }

    /**
     * Load an export file. JSON text rather than an input type, because the
     * API's ValidationPipe rejects unknown properties and an export file from
     * an older version carries keys this one does not declare. PHP ignores
     * those, and so does the service.
     */
    @UsePermissions({ action: AuthAction.CREATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersImportResult, { description: 'Create folders from an export file.' })
    public importDockerFolders(@Args('configJson') configJson: string): DockerFoldersImportResult {
        let config: unknown;
        try {
            config = JSON.parse(configJson);
        } catch {
            throw new BadRequestException('Invalid JSON data');
        }
        const result = this.folderService.importConfiguration(config);
        // PHP answers a failed import with an error status and this message.
        if (!result.success) throw new Error(`Import failed: ${result.errors.join(', ')}`);
        return {
            success: result.success,
            foldersCreated: result.folders_created,
            containersAssigned: result.containers_assigned,
            errors: result.errors,
        };
    }
}
