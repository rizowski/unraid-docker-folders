import { BadRequestException } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { AuthAction, Resource } from '@unraid/shared/graphql.model.js';
import { UsePermissions } from '@unraid/shared/use-permissions.directive.js';

import {
    DockerFoldersSchedule,
    DockerFoldersScheduleHistoryEntry,
    DockerFoldersScheduleInput,
    DockerFoldersScheduleRun,
    DockerFoldersScheduleRunner,
    DockerFoldersScheduleToggle,
} from './schedule.model.js';
import { ScheduleService, type ScheduleHistoryRow, type ScheduleRow, type ScheduleWrite } from './schedule.service.js';
import { SchedulerService } from './scheduler.service.js';

/**
 * The schedules screen, ported from `api/schedules.php`.
 *
 * `dockerFoldersScheduleRunner` doubles as a capability probe. The PHP runner
 * stands down in GraphQL mode only when this field exists, because an older
 * plugin without a scheduler would otherwise answer the plain probe, PHP
 * would stop, and nothing would run the user's schedules at all.
 */
@Resolver()
export class ScheduleResolver {
    constructor(
        private readonly schedules: ScheduleService,
        private readonly scheduler: SchedulerService
    ) {}

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersSchedule])
    public dockerFoldersSchedules(
        @Args('targetType', { type: () => String, nullable: true }) targetType?: string,
        @Args('targetId', { type: () => String, nullable: true }) targetId?: string
    ): DockerFoldersSchedule[] {
        return this.schedules
            .list({ target_type: targetType ?? undefined, target_id: targetId ?? undefined })
            .map(toSchedule);
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => DockerFoldersScheduleRunner)
    public dockerFoldersScheduleRunner(): DockerFoldersScheduleRunner {
        return toRunner(this.scheduler.runnerState());
    }

    @UsePermissions({ action: AuthAction.READ_ANY, resource: Resource.DOCKER })
    @Query(() => [DockerFoldersScheduleHistoryEntry])
    public dockerFoldersScheduleHistory(
        @Args('id', { type: () => Int }) id: number,
        @Args('limit', { type: () => Int, nullable: true }) limit?: number
    ): DockerFoldersScheduleHistoryEntry[] {
        return this.schedules.history(id, limit ?? 50).map(toHistory);
    }

    @UsePermissions({ action: AuthAction.CREATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Int, { description: 'Create a schedule and answer its id.' })
    public createDockerFoldersSchedule(@Args('input') input: DockerFoldersScheduleInput): number {
        return this.schedules.create(toWrite(input));
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean)
    public updateDockerFoldersSchedule(
        @Args('id', { type: () => Int }) id: number,
        @Args('input') input: DockerFoldersScheduleInput
    ): boolean {
        return this.schedules.update(id, toWrite(input));
    }

    @UsePermissions({ action: AuthAction.DELETE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean)
    public deleteDockerFoldersSchedule(@Args('id', { type: () => Int }) id: number): boolean {
        return this.schedules.delete(id);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Boolean)
    public toggleDockerFoldersSchedule(
        @Args('id', { type: () => Int }) id: number,
        @Args('enabled') enabled: boolean
    ): boolean {
        return this.schedules.toggle(id, enabled);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Int, { description: 'Answers how many schedules changed.' })
    public bulkToggleDockerFoldersSchedules(
        @Args('updates', { type: () => [DockerFoldersScheduleToggle] }) updates: DockerFoldersScheduleToggle[]
    ): number {
        return this.schedules.bulkSetEnabled(updates);
    }

    @UsePermissions({ action: AuthAction.DELETE_ANY, resource: Resource.DOCKER })
    @Mutation(() => Int, { description: 'Answers how many ids were acted on.' })
    public bulkDeleteDockerFoldersSchedules(
        @Args('ids', { type: () => [Int] }) ids: number[]
    ): number {
        return this.schedules.bulkDelete(ids);
    }

    @UsePermissions({ action: AuthAction.UPDATE_ANY, resource: Resource.DOCKER })
    @Mutation(() => DockerFoldersScheduleRun, { description: 'Run a schedule now.' })
    public async runDockerFoldersSchedule(
        @Args('id', { type: () => Int }) id: number
    ): Promise<DockerFoldersScheduleRun> {
        const result = await this.schedules.execute(id);
        return {
            success: result.success,
            scheduleId: result.schedule_id,
            status: result.status,
            message: result.message,
        };
    }
}

function toWrite(input: DockerFoldersScheduleInput): ScheduleWrite {
    if (input.backupConfigJson !== undefined && input.backupConfigJson !== null) {
        try {
            JSON.parse(input.backupConfigJson);
        } catch {
            throw new BadRequestException('backup_config must be valid JSON');
        }
    }
    return {
        name: input.name,
        target_type: input.targetType,
        target_id: input.targetId,
        action: input.action,
        cron_expression: input.cronExpression,
        enabled: input.enabled,
        backup_config: input.backupConfigJson,
    };
}

function toSchedule(row: ScheduleRow): DockerFoldersSchedule {
    return {
        id: Number(row.id),
        name: row.name,
        targetType: row.target_type,
        targetId: row.target_id,
        action: row.action,
        cronExpression: row.cron_expression,
        enabled: Boolean(row.enabled),
        backupConfigJson: row.backup_config ?? null,
        lastRunAt: row.last_run_at ?? null,
        lastRunStatus: row.last_run_status ?? null,
        lastRunMessage: row.last_run_message ?? null,
        nextRunAt: row.next_run_at ?? null,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

function toHistory(row: ScheduleHistoryRow): DockerFoldersScheduleHistoryEntry {
    return {
        id: Number(row.id),
        scheduleId: Number(row.schedule_id),
        startedAt: Number(row.started_at),
        finishedAt: row.finished_at ?? null,
        status: row.status,
        message: row.message ?? null,
        backupFile: row.backup_file ?? null,
        backupSize: row.backup_size ?? null,
    };
}

function toRunner(state: ReturnType<SchedulerService['runnerState']>): DockerFoldersScheduleRunner {
    return {
        lastTick: state.last_tick,
        stale: state.stale,
        staleAfter: state.stale_after,
        cronInstalled: state.cron_installed,
        repaired: state.repaired,
    };
}
