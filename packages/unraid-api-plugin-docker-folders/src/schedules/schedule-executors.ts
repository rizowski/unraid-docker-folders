import { Inject, Injectable } from '@nestjs/common';

import { BackupService, quiesceModeFor as backupQuiesceMode } from '../backups/backup.service.js';
import { ContainerService } from '../containers/container.service.js';
import { DOCKER_CLIENT_TOKEN } from '../containers/docker-client.js';
import type { ActionOutcome, ScheduleExecutors, ScheduleRow } from './schedule.service.js';

/**
 * What a schedule does when it fires, ported from `ScheduleManager`'s
 * `dispatchAction`, `executeContainerAction`, `executeStackAction` and
 * `executeBackup`.
 *
 * The messages are PHP's, word for word, because they land in the schedule's
 * history and in the Unraid notification a failed run sends.
 */

/** A Compose stack action, supplied by the compose service. */
export interface StackActionRunner {
    stackUp(project: string): Promise<{ success: boolean; output?: string | null }>;
    stackStop(project: string): Promise<{ success: boolean; output?: string | null }>;
    stackRestart(project: string): Promise<{ success: boolean; output?: string | null }>;
}

export const STACK_ACTION_RUNNER_TOKEN = 'DOCKER_FOLDERS_STACK_ACTION_RUNNER';

/** The slice of Docker this needs that the container actions do not cover. */
export interface ExecutorDockerClient {
    listContainers(options: { all: boolean }): Promise<{ Id: string; Names?: string[]; State?: string }[]>;
    getContainer(id: string): { pause(): Promise<unknown> };
}

@Injectable()
export class DockerFoldersScheduleExecutors implements ScheduleExecutors {
    constructor(
        private readonly containers: ContainerService,
        private readonly backups: BackupService,
        @Inject(DOCKER_CLIENT_TOKEN) private readonly docker: ExecutorDockerClient,
        @Inject(STACK_ACTION_RUNNER_TOKEN) private readonly stacks: StackActionRunner
    ) {}

    async containerAction(containerName: string, action: string): Promise<ActionOutcome> {
        const list = await this.docker.listContainers({ all: true });
        const container = list.find((c) => (c.Names?.[0] ?? '').replace(/^\//, '') === containerName);
        if (container === undefined) {
            return { success: false, message: `Container '${containerName}' not found` };
        }

        const verb = ucfirst(action);
        // A resume that finds the container running has nothing to do, and
        // that is not a failure.
        if (action === 'resume' && container.State !== 'paused') {
            return { success: true, message: `${containerName} is not paused; nothing to do` };
        }

        try {
            switch (action) {
                // `start` resumes a paused container itself, in ContainerService
                // as in DockerClient.php, so the rule lives in one place.
                case 'start':
                    await this.containers.start(container.Id);
                    break;
                case 'resume':
                    await this.containers.resume(container.Id);
                    break;
                case 'stop':
                    await this.containers.stop(container.Id);
                    break;
                case 'restart':
                    await this.containers.restart(container.Id);
                    break;
                case 'pause':
                    await pause(this.docker, container.Id);
                    break;
                default:
                    return { success: false, message: `Unknown action: ${action}` };
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { success: false, message: `${verb} failed for ${containerName}: ${reason}` };
        }

        return { success: true, message: `${verb} succeeded for ${containerName}` };
    }

    async stackAction(projectName: string, action: string): Promise<ActionOutcome> {
        let result: { success: boolean; output?: string | null };
        switch (action) {
            case 'start':
                result = await this.stacks.stackUp(projectName);
                break;
            case 'stop':
                result = await this.stacks.stackStop(projectName);
                break;
            case 'restart':
                result = await this.stacks.stackRestart(projectName);
                break;
            case 'pause':
                return { success: false, message: 'Pause is not supported for compose stacks' };
            case 'resume':
                return { success: false, message: 'Resume is not supported for compose stacks' };
            default:
                return { success: false, message: `Unknown action: ${action}` };
        }

        const verb = ucfirst(action);
        return {
            success: result.success,
            message: result.success
                ? `${verb} succeeded for stack ${projectName}`
                : `${verb} failed for stack ${projectName}: ${result.output ?? ''}`,
        };
    }

    async backup(schedule: ScheduleRow): Promise<ActionOutcome> {
        let config: { paths?: unknown; destination?: unknown; retention_count?: unknown; quiesce?: unknown } | null;
        try {
            config = schedule.backup_config === null ? null : JSON.parse(schedule.backup_config);
        } catch {
            config = null;
        }
        if (config === null || typeof config !== 'object' || !nonEmpty(config.paths)) {
            return { success: false, message: 'Invalid backup configuration' };
        }

        // PHP's `!empty()`: null, '', 0 and '0' all mean "use the default".
        const destination = phpEmpty(config.destination) ? null : String(config.destination);
        const retention = phpEmpty(config.retention_count) ? null : Math.trunc(Number(config.retention_count));
        // Coerced to one of three known strings. An unknown value leaves the
        // container alone rather than failing a run nobody is watching.
        const quiesce = backupQuiesceMode(config.quiesce);

        const result =
            schedule.target_type === 'container'
                ? await this.backups.backupContainer(
                      schedule.target_id,
                      config.paths as string[],
                      destination,
                      retention,
                      quiesce
                  )
                : await this.backups.backupStack(
                      schedule.target_id,
                      config.paths as Parameters<BackupService['backupStack']>[1],
                      destination,
                      retention,
                      quiesce
                  );

        return {
            success: result.success,
            message: result.message,
            ...(result.backupFile ? { backup_file: result.backupFile, backup_size: result.backupSize ?? 0 } : {}),
        };
    }
}

/** Pause, where Docker's 304 for "already paused" counts as done, as in PHP. */
async function pause(docker: ExecutorDockerClient, id: string): Promise<void> {
    try {
        await docker.getContainer(id).pause();
    } catch (error) {
        if ((error as { statusCode?: number } | null)?.statusCode !== 304) throw error;
    }
}

function ucfirst(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function nonEmpty(value: unknown): boolean {
    return Array.isArray(value) ? value.length > 0 : !phpEmpty(value);
}

function phpEmpty(value: unknown): boolean {
    return value === undefined || value === null || value === '' || value === 0 || value === '0' || value === false;
}
