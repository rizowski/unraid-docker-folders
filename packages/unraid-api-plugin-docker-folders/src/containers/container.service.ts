import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { EventBusService } from '../events/event-bus.service.js';
import { FolderService } from '../folders/folder.service.js';
import {
    DOCKER_CLIENT_TOKEN,
    type DockerClient,
    type DockerContainerHandle,
} from './docker-client.js';

/**
 * Seconds Docker waits for a clean exit before it kills the process. Ten is
 * what `DockerClient::stopContainer` and `restartContainer` both pass.
 */
const STOP_TIMEOUT_SECONDS = 10;

/**
 * Docker answers "already in that state" with 304, and that counts as success.
 *
 * `DockerClient.php` returns true on a 304 outright. dockerode raises it as an
 * error instead, so without this, stopping a container that is already stopped
 * succeeds in PHP mode and fails in GraphQL mode. Schedules fire actions
 * without checking state first, so that difference would show up as a failed
 * scheduled stop rather than as a no-op. Seen on tower, stopping a container
 * that had been exited for two weeks:
 * "(HTTP code 304) container already stopped".
 */
function isNotModified(error: unknown): boolean {
    return (error as { statusCode?: number } | null)?.statusCode === 304;
}

/**
 * Start, stop, restart, resume and remove, ported from `DockerClient.php`.
 *
 * These are the plugin's own mutations rather than calls to upstream's
 * `docker.mutations`, which was the original plan. Four things decided that,
 * read from the `unraid/api` source at the `v4.35.1` tag, which is the
 * version on the target server:
 *
 * - There is no `restart` mutation. It arrives in 4.37.x, so on the version
 *   users have, a button the plugin needs simply is not there.
 * - Upstream's `start` calls Docker's start, which answers 304 on a paused
 *   container and leaves it paused. PHP inspects first and resumes instead.
 * - Upstream's `removeContainer` always passes force. PHP forces only when
 *   the caller asks, and the frontend never does, so a running container
 *   refuses to be removed rather than being killed.
 * - Upstream cannot know about `container_folders` or `unfoldered_order`, so
 *   a container removed through it would keep its folder membership forever.
 *
 * Splitting five buttons between two owners by API version would have been
 * worse than owning all five, and owning them keeps the same behavior in both
 * backend modes, which is what makes the two comparable at all.
 */
@Injectable()
export class ContainerService {
    private readonly logger = new Logger(ContainerService.name);

    constructor(
        @Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerClient,
        private readonly folders: FolderService,
        private readonly events: EventBusService
    ) {}

    /**
     * Docker answers a start on a paused container with 304 and leaves it
     * paused, so a paused container is resumed instead. Same reasoning, and
     * the same inspect, as `DockerClient::startContainer`.
     */
    async start(id: string): Promise<boolean> {
        return this.act('start', id, async (container) => {
            const info = await container.inspect();
            if (info.State?.Paused === true) {
                await container.unpause();
                return;
            }
            await container.start();
        });
    }

    async resume(id: string): Promise<boolean> {
        return this.act('resume', id, (container) => container.unpause());
    }

    async stop(id: string): Promise<boolean> {
        return this.act('stop', id, (container) => container.stop({ t: STOP_TIMEOUT_SECONDS }));
    }

    async restart(id: string): Promise<boolean> {
        return this.act('restart', id, (container) =>
            container.restart({ t: STOP_TIMEOUT_SECONDS })
        );
    }

    /**
     * Remove a container, and forget it.
     *
     * The inspect has to come first, because the name and image id are only
     * readable while the container exists. Not forced, which matches PHP and
     * means a running container is refused rather than killed.
     *
     * A failed image removal is logged and swallowed, as it is in PHP: the
     * container is already gone, so failing the call now would report a
     * removal that did happen as one that did not.
     */
    async remove(id: string, removeImage = false): Promise<boolean> {
        const container = this.docker.getContainer(id);

        let name: string | null = null;
        let imageId: string | null = null;
        try {
            const info = await container.inspect();
            name = typeof info.Name === 'string' ? info.Name.replace(/^\//, '') : null;
            imageId = typeof info.Image === 'string' ? info.Image : null;
        } catch (error) {
            throw this.failure('remove', id, error);
        }

        try {
            await container.remove({ force: false });
        } catch (error) {
            throw this.failure('remove', id, error);
        }

        if (name !== null) {
            // PHP publishes this one as entity "folders", which the frontend's
            // dispatch table does not match, so a second tab only catches up
            // on its poll. The service publishes "folder" from mutate(), which
            // is the name the table reads.
            this.folders.forgetContainer(name);
        }

        if (removeImage && imageId !== null) {
            try {
                await this.docker.getImage(imageId).remove({ force: true });
            } catch (error) {
                this.logger.warn(`Could not remove image ${imageId}: ${String(error)}`);
            }
        }

        this.events.publish('container', 'remove');
        return true;
    }

    /**
     * Run one action, then tell open tabs about it.
     *
     * Same reasoning as `FolderService.mutate`: an action that threw did not
     * happen and must not announce itself, and an action added later cannot
     * forget to.
     */
    private async act(
        action: string,
        id: string,
        work: (container: DockerContainerHandle) => Promise<unknown>
    ): Promise<boolean> {
        try {
            await work(this.docker.getContainer(id));
        } catch (error) {
            if (!isNotModified(error)) throw this.failure(action, id, error);
        }
        this.events.publish('container', action);
        return true;
    }

    /**
     * Docker's own message is kept, because it names the real reason: a
     * conflict on removing a running container, or a missing image. A 404
     * becomes NotFoundException so the resolver stays pure delegation.
     */
    private failure(action: string, id: string, error: unknown): Error {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Could not ${action} container ${id}: ${reason}`);

        const status = (error as { statusCode?: number } | null)?.statusCode;
        if (status === 404) {
            return new NotFoundException(`No container with id ${id}`);
        }
        return new Error(`Could not ${action} container: ${reason}`);
    }
}
