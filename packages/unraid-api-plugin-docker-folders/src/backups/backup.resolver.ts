import { BadRequestException } from '@nestjs/common';
import { Args, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import { BackupService } from './backup.service.js';

@ObjectType()
export class DockerFoldersBackupEntry {
    @Field(() => String) path!: string;
    @Field(() => String) filename!: string;
    // Float, because an archive can be larger than GraphQL's 32-bit Int.
    @Field(() => Number) size!: number;
    @Field(() => Int) createdAt!: number;
}

/**
 * The backups list and delete on the schedules screen, ported from the
 * `backups` and `delete_backup` actions of `api/schedules.php`.
 */
@Resolver()
export class BackupResolver {
    constructor(private readonly backups: BackupService) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersBackupEntry], { description: "A target's archives, newest first." })
    public dockerFoldersBackups(
        @Args('targetType') targetType: string,
        @Args('targetId') targetId: string
    ): DockerFoldersBackupEntry[] {
        if (targetType === '' || targetId === '') {
            throw new BadRequestException('Missing target_type or target_id');
        }
        return this.backups.listBackups(targetType, targetId);
    }

    @UsePermissions({ action: AuthAction.DELETE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean, { description: 'Delete one archive. Refuses anything that is not one.' })
    public deleteDockerFoldersBackup(@Args('path') path: string): boolean {
        if (path === '') throw new BadRequestException('Missing backup path');
        if (!this.backups.deleteBackup(path)) throw new BadRequestException('Failed to delete backup');
        return true;
    }
}
