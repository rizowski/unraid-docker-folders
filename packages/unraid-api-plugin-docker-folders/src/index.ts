import { Module } from '@nestjs/common';

import { StatusCommand } from './cli/status.command.js';
import { BackupResolver } from './backups/backup.resolver.js';
import { BACKUP_DOCKER_CLIENT_TOKEN, BackupService, createBackupDockerClient } from './backups/backup.service.js';
import { COMPOSE_RUNNER_TOKEN, createComposeRunner } from './compose/compose-runner.js';
import { ComposeResolver } from './compose/compose.resolver.js';
import { ComposeService } from './compose/compose.service.js';
import { AdoptService } from './containers/adopt.service.js';
import { AutostartService } from './containers/autostart.service.js';
import { ContainerExtrasResolver } from './containers/container-extras.resolver.js';
import { ContainerListResolver } from './containers/container-list.resolver.js';
import { ContainerLogsService } from './containers/container-logs.service.js';
import { ContainerStatsService } from './containers/container-stats.service.js';
import { ContainerListService } from './containers/container-list.service.js';
import { ContainerResolver } from './containers/container.resolver.js';
import { ContainerService } from './containers/container.service.js';
import { SecurityService } from './containers/security.service.js';
import { DOCKER_CLIENT_TOKEN, createDockerClient } from './containers/docker-client.js';
import { DatabaseService } from './db/database.service.js';
import { DockerEventService } from './events/docker-event.service.js';
import { EventBusService } from './events/event-bus.service.js';
import { EventResolver } from './events/event.resolver.js';
import { NchanService } from './events/nchan.service.js';
import { FolderResolver } from './folders/folder.resolver.js';
import { FolderService } from './folders/folder.service.js';
import { PathBrowserResolver } from './paths/path-browser.resolver.js';
import { PathBrowserService } from './paths/path-browser.service.js';
import { DockerFoldersScheduleExecutors, STACK_ACTION_RUNNER_TOKEN } from './schedules/schedule-executors.js';
import { ScheduleResolver } from './schedules/schedule.resolver.js';
import { SCHEDULE_EXECUTORS_TOKEN, ScheduleService } from './schedules/schedule.service.js';
import { SchedulerService } from './schedules/scheduler.service.js';
import { RecreateService } from './updates/recreate.service.js';
import { ReleaseNotesService } from './updates/release-notes.service.js';
import { UpdateLogService } from './updates/update-log.service.js';
import { UpdatesResolver } from './updates/updates.resolver.js';
import { UpdatesService } from './updates/updates.service.js';
import { SettingsResolver } from './settings/settings.resolver.js';
import { SettingsService } from './settings/settings.service.js';

/**
 * The plugin contract. PluginService validates this shape with zod and
 * PluginModule.register() spreads ApiModule into the Nest imports array, which
 * is what merges our resolvers into the one code-first schema.
 */
export const adapter = 'nestjs';

/**
 * The Docker client is a factory rather than a class provider because it opens
 * a socket. The CLI module does not list it, so `unraid-api
 * docker-folders:status` keeps working on a box with Docker stopped.
 */
const dockerClientProvider = {
    provide: DOCKER_CLIENT_TOKEN,
    useFactory: createDockerClient,
};

const composeRunnerProvider = {
    provide: COMPOSE_RUNNER_TOKEN,
    useFactory: () => createComposeRunner(),
};

const backupDockerClientProvider = {
    provide: BACKUP_DOCKER_CLIENT_TOKEN,
    useFactory: createBackupDockerClient,
};

/** A scheduled stack action is a Compose action, run by the compose service. */
const stackActionRunnerProvider = {
    provide: STACK_ACTION_RUNNER_TOKEN,
    useExisting: ComposeService,
};

const scheduleExecutorsProvider = {
    provide: SCHEDULE_EXECUTORS_TOKEN,
    useExisting: DockerFoldersScheduleExecutors,
};

@Module({
    providers: [
        DatabaseService,
        NchanService,
        EventBusService,
        EventResolver,
        FolderService,
        FolderResolver,
        dockerClientProvider,
        ContainerService,
        ContainerResolver,
        ContainerListService,
        SecurityService,
        ContainerListResolver,
        ContainerLogsService,
        ContainerStatsService,
        AutostartService,
        AdoptService,
        ContainerExtrasResolver,
        SettingsService,
        SettingsResolver,
        PathBrowserService,
        PathBrowserResolver,
        composeRunnerProvider,
        ComposeService,
        ComposeResolver,
        backupDockerClientProvider,
        BackupService,
        BackupResolver,
        stackActionRunnerProvider,
        DockerFoldersScheduleExecutors,
        scheduleExecutorsProvider,
        ScheduleService,
        SchedulerService,
        ScheduleResolver,
        UpdateLogService,
        ReleaseNotesService,
        RecreateService,
        UpdatesService,
        UpdatesResolver,
        DockerEventService,
    ],
    exports: [FolderService, ContainerService],
})
class DockerFoldersApiModule {}

@Module({
    providers: [DatabaseService, NchanService, EventBusService, FolderService, StatusCommand],
})
class DockerFoldersCliModule {}

export const ApiModule = DockerFoldersApiModule;
export const CliModule = DockerFoldersCliModule;
