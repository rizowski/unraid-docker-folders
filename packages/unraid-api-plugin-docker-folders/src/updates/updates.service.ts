import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Observable } from 'rxjs';

import {
    DOCKER_CLIENT_TOKEN,
    DOCKER_SOCKET_PATH,
    type DockerClient,
    type DockerInspectInfo,
    type DockerListContainer,
} from '../containers/docker-client.js';
import { DatabaseService, type Row } from '../db/database.service.js';
import { EventBusService } from '../events/event-bus.service.js';
import { sendUnraidNotification } from '../schedules/schedule-notifications.js';
import { nowSeconds } from '../util/time.js';
import {
    errorMessage,
    globMatch,
    nullableString,
    type RecreateCandidate,
    resolveImageTag,
    selectRecreateTargets,
    stripLeadingSlash,
} from './docker-refs.js';
import type { DockerFoldersPullEvent } from './pull-events.js';
import { RecreateService, type RecreateResult } from './recreate.service.js';
import { parseRepo, toReleaseNote } from './release-notes.util.js';
import { ReleaseNotesService } from './release-notes.service.js';
import { UpdateLogService } from './update-log.service.js';
import {
    UNRAID_STATUS_PATHS,
    containerNamesForImage,
    containersBehindImage,
    markUnraidImageCurrent,
    pickUnraidDigest,
    pullDigestFromStatus,
    repairUnraidUpdateStatus,
    unraidImageKey,
    type UnraidStatusPaths,
} from './unraid-update-status.js';
import { buildUpdateNotification } from './update-notifications.js';
import type { DockerFoldersImagePullResult, DockerFoldersImageUpdateStatus } from './updates.model.js';

/**
 * `preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]+$/')` plus the 255 cap, copied
 * character-for-character from `pull.php`.
 */
const IMAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/;
const MAX_IMAGE_NAME_LENGTH = 255;

/** `pull.php`'s validation for each entry of `containers=`. */
const CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;

/** `DockerClient::pullImage`'s `CURLOPT_TIMEOUT` — the whole pull, not per chunk. */
const PULL_TIMEOUT_MS = 600_000;

/** What a pull stream ended with: its last `error` line, and its `Digest:` line. */
interface PullStreamOutcome {
    error: string | null;
    digest: string | null;
}

/** Label PHP reads off the local image to link a container to its GitHub repo. */
const SOURCE_LABEL = 'org.opencontainers.image.source';

/** Overrides the Docker socket path `runScheduledCheck` checks for. Only the tests supply one. */
export const DOCKER_SOCKET_PATH_TOKEN = 'DOCKER_FOLDERS_UPDATE_SOCKET_PATH';

/** Overrides where Unraid's update-status files live. Only the tests supply one. */
export const UNRAID_STATUS_PATHS_TOKEN = 'DOCKER_FOLDERS_UNRAID_STATUS_PATHS';

/**
 * `CronManager::$schedules`, byte-for-byte. The coordinator's scheduler reads
 * this map plus `settings.update_check_schedule` and computes "when next"
 * with `computeNextRun()` from `../schedules/cron.js` — this service does not
 * time anything itself. `'disabled'` is deliberately absent: PHP handles it
 * by falling through to "no schedule" rather than storing an expression for
 * it.
 */
export const UPDATE_CHECK_SCHEDULES: Readonly<Record<string, string>> = {
    hourly: '0 * * * *',
    daily: '0 3 * * *',
    twice_daily: '0 3,15 * * *',
    weekly: '0 3 * * 0',
};

interface OneImageCheck {
    localDigest: string | null;
    remoteDigest: string | null;
    updateAvailable: boolean;
    sourceUrl: string | null;
    error: string | null;
}

interface ExistingCheck {
    updateAvailable: boolean;
    remoteDigest: string | null;
}

export interface PullOptions {
    /** Restrict auto-recreate to these container ids. Omitted matches by image, like PHP's default. */
    containers?: string[];
    /** Force a recreate even without a detected update. Requires `containers`. */
    recreate?: boolean;
    /**
     * Skip the pull and recreate `containers` on the image already on disk,
     * PHP's `recreate_only=1`. Applies an update pulled earlier: pulling again
     * would fail for an image built locally, and could swap in a build newer
     * than the one the user chose to apply. Requires `containers`.
     */
    recreateOnly?: boolean;
}

function toStatus(row: Row, notes: Map<string, Row>): DockerFoldersImageUpdateStatus {
    const sourceRepo = nullableString(row.source_repo);
    return {
        image: String(row.image),
        localDigest: nullableString(row.local_digest),
        remoteDigest: nullableString(row.remote_digest),
        updateAvailable: Number(row.update_available ?? 0) === 1,
        checkedAt: Number(row.checked_at ?? 0),
        error: nullableString(row.error),
        sourceUrl: nullableString(row.source_url),
        sourceRepo,
        release: sourceRepo !== null ? toReleaseNote(notes.get(sourceRepo)) : null,
    };
}

function readExcludePatterns(db: DatabaseSync): string[] {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'update_check_exclude'").get() as
        | { value?: string }
        | undefined;
    if (!row?.value) return [];
    return row.value
        .split(',')
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern !== '');
}

function readPostPullAction(db: DatabaseSync): string {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'post_pull_action'").get() as
        | { value?: string }
        | undefined;
    return row?.value ? row.value : 'pull_only';
}

function readNotifyOnUpdates(db: DatabaseSync): boolean {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'notify_on_updates'").get() as
        | { value?: string }
        | undefined;
    return row?.value === '1';
}

function readExistingChecks(db: DatabaseSync): Map<string, ExistingCheck> {
    const rows = db.prepare('SELECT image, update_available, remote_digest FROM image_update_checks').all() as Row[];
    const map = new Map<string, ExistingCheck>();
    for (const row of rows) {
        map.set(String(row.image), {
            updateAvailable: Number(row.update_available ?? 0) === 1,
            remoteDigest: nullableString(row.remote_digest),
        });
    }
    return map;
}

function readReleaseNotes(db: DatabaseSync): Map<string, Row> {
    const rows = db.prepare('SELECT * FROM release_notes').all() as Row[];
    return new Map(rows.map((row): [string, Row] => [String(row.repo), row]));
}

interface CheckOutcome {
    results: DockerFoldersImageUpdateStatus[];
    /** Image -> the container names running it, for the update notification. */
    containersByImage: Map<string, string[]>;
    /** The `image_update_checks` state from *before* this run — `runScheduledCheck`'s "previous" snapshot. */
    existingBefore: Map<string, ExistingCheck>;
    checked: number;
    skipped: number;
    errors: number;
    newUpdates: number;
}

/**
 * Image update checking, pulling, and recreating, ported from
 * `api/updates.php`, `api/pull.php`, `scripts/check-updates.php`, the shared
 * `checkAllImageUpdates()`/`buildUpdateNotification()` in `config.php`, and
 * `DockerClient::recreateContainer` (via `RecreateService`).
 *
 * `checkForUpdates()` and `runScheduledCheck()` share `performCheck()`, the
 * port of `checkAllImageUpdates()` itself; they differ only in what they log
 * before/after and in `runScheduledCheck()`'s extra notification step —
 * exactly the split between `updates.php`'s `handlePost()` and
 * `check-updates.php` in PHP.
 *
 * `pullImage()` and `pullImageEvents()` share `runPull()`. The mutation wants
 * only the terminal result; the Observable wants every event `pull.php`
 * streams over SSE along the way. Both take the same `PullOptions`
 * (`containers`/`recreate`), matching PHP where there is only one endpoint.
 *
 * `updateContainer()`, ported from `ScheduleManager::executeContainerUpdate()`,
 * is a fourth pull path with its own rules: it calls `performCheck()` for a
 * single tag and `pullOnly()` (the part of `runPull()` shared with it) for
 * the pull itself, but never `runPull()` as a whole — it recreates only its
 * one container and ignores `post_pull_action` completely, where `runPull()`
 * always applies the setting.
 */
@Injectable()
export class UpdatesService {
    private readonly logger = new Logger(UpdatesService.name);

    constructor(
        @Inject(DOCKER_CLIENT_TOKEN) private readonly docker: DockerClient,
        private readonly db: DatabaseService,
        private readonly events: EventBusService,
        private readonly updateLog: UpdateLogService,
        private readonly releaseNotes: ReleaseNotesService,
        private readonly recreate: RecreateService,
        @Optional()
        @Inject(DOCKER_SOCKET_PATH_TOKEN)
        private readonly socketPath: string = DOCKER_SOCKET_PATH,
        @Optional()
        @Inject(UNRAID_STATUS_PATHS_TOKEN)
        private readonly unraidPaths: UnraidStatusPaths = UNRAID_STATUS_PATHS
    ) {}

    /** `GET /api/updates.php`: cached results, joined with cached release notes. */
    getCached(): DockerFoldersImageUpdateStatus[] {
        return this.db.read((db) => {
            const notes = readReleaseNotes(db);
            const rows = db.prepare('SELECT * FROM image_update_checks').all() as Row[];
            return rows.map((row) => toStatus(row, notes));
        });
    }

    /**
     * `POST /api/updates.php?action=check`: check every running container's
     * image, or only `onlyImages` when given.
     */
    async checkForUpdates(onlyImages: string[] | null = null): Promise<DockerFoldersImageUpdateStatus[]> {
        let filtered: string[] | null = null;
        if (onlyImages !== null) {
            filtered = onlyImages.filter((image) => image !== '');
            if (filtered.length === 0) {
                throw new BadRequestException('images must contain at least one image reference');
            }
        }

        this.updateLog.log(
            filtered !== null
                ? `START Targeted update check begun (${filtered.length} image(s))`
                : 'START Manual update check begun'
        );

        const outcome = await this.performCheck(filtered);

        this.updateLog.log(
            `DONE Checked ${outcome.checked}, skipped ${outcome.skipped}, errors ${outcome.errors}, updates ${outcome.newUpdates}`
        );

        return outcome.results;
    }

    /**
     * `scripts/check-updates.php`, as a method instead of a cron-invoked
     * script. The coordinator's scheduler calls this on the timer it builds
     * from `UPDATE_CHECK_SCHEDULES` — nothing here schedules itself.
     */
    async runScheduledCheck(): Promise<void> {
        if (!existsSync(this.socketPath)) {
            this.updateLog.log('SKIP Docker socket not available');
            return;
        }

        this.updateLog.log('START Update check begun');

        const outcome = await this.performCheck(null);

        // "New" here means newly available *since the last check* — the
        // snapshot performCheck() took before writing this run's results —
        // not merely available this run (that's outcome.newUpdates, used by
        // checkForUpdates()'s own DONE line instead).
        const newImages = outcome.results
            .filter((r) => r.updateAvailable && !(outcome.existingBefore.get(r.image)?.updateAvailable ?? false))
            .map((r) => r.image);

        const notifyEnabled = this.db.read((db) => readNotifyOnUpdates(db));
        if (notifyEnabled) {
            const notification = buildUpdateNotification(newImages, outcome.containersByImage);
            if (notification !== null) {
                sendUnraidNotification(notification);
                this.updateLog.log(`NOTIFY Sent notification: ${notification.subject} (${notification.description})`);
            }
        }

        this.updateLog.log(
            `DONE Checked ${outcome.checked}, skipped ${outcome.skipped}, errors ${outcome.errors}, new updates ${newImages.length}`
        );
    }

    /**
     * `POST /api/pull.php`: pull one image, refresh its cached digests on
     * success, auto-recreate if `post_pull_action` or `recreate` says to, and
     * announce it. Returns only the terminal result — see `pullImageEvents`
     * for the same pull as a stream of every intermediate event.
     */
    async pullImage(image: string, options?: PullOptions): Promise<DockerFoldersImagePullResult> {
        const { onlyContainerIds, forceRecreate, recreateOnly } = this.validatePullRequest(image, options);
        if (recreateOnly && onlyContainerIds !== null) return this.runRecreateOnly(image, onlyContainerIds, () => {});
        return this.runPull(image, onlyContainerIds, forceRecreate, () => {});
    }

    /**
     * The same pull as `pullImage()`, as an Observable of every event
     * `pull.php` streams over SSE (`DockerFoldersPullEvent` in
     * `pull-events.ts`). Building the GraphQL subscription and union type
     * around this is left to the caller — see that file's doc comment.
     *
     * Cold: nothing happens until subscribed, and subscribing starts a real
     * pull. There is no replay for a second subscriber and no dedup between
     * two subscriptions for the same image. Unsubscribing does not cancel the
     * underlying pull — it keeps running to completion in the background,
     * the same way `pull.php`'s `ignore_user_abort(true)` keeps a PHP request
     * running after the browser disconnects.
     */
    pullImageEvents(image: string, options?: PullOptions): Observable<DockerFoldersPullEvent> {
        const { onlyContainerIds, forceRecreate, recreateOnly } = this.validatePullRequest(image, options);

        return new Observable<DockerFoldersPullEvent>((subscriber) => {
            const emit = (event: DockerFoldersPullEvent) => subscriber.next(event);
            const run =
                recreateOnly && onlyContainerIds !== null
                    ? this.runRecreateOnly(image, onlyContainerIds, emit)
                    : this.runPull(image, onlyContainerIds, forceRecreate, emit);
            run
                .then((result) => {
                    // Exactly one terminal event, then `done`, then complete —
                    // mirrors pull.php's `complete`/`error` followed
                    // unconditionally by `done`.
                    subscriber.next(
                        result.success
                            ? {
                                  type: 'complete',
                                  message: recreateOnly ? 'Recreate complete' : 'Pull complete',
                                  image: result.image,
                              }
                            : { type: 'error', message: result.error ?? 'Pull failed' }
                    );
                    subscriber.next({ type: 'done', finished: true });
                    subscriber.complete();
                })
                .catch((error: unknown) => {
                    subscriber.next({ type: 'error', message: errorMessage(error) });
                    subscriber.next({ type: 'done', finished: true });
                    subscriber.complete();
                });
        });
    }

    /**
     * `ScheduleManager::executeContainerUpdate()`: update one container to
     * the newest build of its image tag. Checks the tag against its
     * registry, pulls it when the registry has a newer build, then recreates
     * the container when the tag now names a different image than the one
     * the container runs. The last test runs even without a pull, because a
     * manual pull or another container's update can bring the tag up to
     * date while this container still runs the old image.
     *
     * Recreates only this container, ignoring `post_pull_action` entirely —
     * unlike `pullImage()`/`autoRecreate()`, this never goes through
     * `runPull()`. `DockerFoldersScheduleExecutors.containerAction()` is the
     * only caller, for the schedule action `update`. The messages are PHP's,
     * word for word, because they land in the schedule's history and in the
     * Unraid notification a failed run sends.
     */
    async updateContainer(containerName: string): Promise<{ success: boolean; message: string }> {
        // Docker's inspect endpoint takes a name directly, so this never
        // lists every container just to find one by name. A name lookup also
        // matches an id prefix, so the answer's own `Name` must match exactly
        // before it is trusted (`ScheduleManager::executeContainerUpdate`).
        let inspect: DockerInspectInfo;
        try {
            inspect = await this.docker.getContainer(containerName).inspect();
        } catch (error) {
            this.logger.warn(`Could not inspect container ${containerName}: ${errorMessage(error)}`);
            return { success: false, message: `Container '${containerName}' not found` };
        }
        if (stripLeadingSlash(inspect.Name ?? '') !== containerName) {
            return { success: false, message: `Container '${containerName}' not found` };
        }
        const containerId = inspect.Id ?? '';
        // The image id the container currently runs, read once here rather
        // than re-inspected after a pull — the same snapshot compared against
        // the registry lookup's answer below.
        const containerImageId = inspect.Image ?? '';

        // The tag the container was created from, not the container-list
        // `Image` field: once the tag moves to a newer build, Docker lists
        // the container under its image ID, and `resolveImageTag`'s name
        // lookup falls back to another tag or a bare `sha256:` reference.
        const image = inspect.Config?.Image ?? '';
        if (image === '' || image.startsWith('sha256:')) {
            return { success: false, message: `Update check failed for ${containerName}: no image reference` };
        }

        this.updateLog.log(`SCHEDULE Update check for ${containerName} (${image})`);
        const outcome = await this.performCheck([image], new Map([[image, image]]), false);
        const result = outcome.results.find((r) => r.image === image);
        if (result === undefined) {
            // Left out only when an exclude pattern matches. Success, so an
            // hourly schedule does not send a failure notice every hour.
            return { success: true, message: `${containerName} is excluded from update checks. Nothing to do` };
        }
        if (result.error) {
            return { success: false, message: `Update check failed for ${containerName}: ${result.error}` };
        }

        let pullDigest: string | null = null;
        if (result.updateAvailable) {
            const pulled = await this.pullOnly(image, () => {});
            if (!pulled.success) {
                return { success: false, message: `Pull failed for ${containerName}: ${pulled.error ?? ''}` };
            }
            pullDigest = pulled.digest;
            this.updateLog.log(`PULL OK ${image}`);
            try {
                await this.recordPulled(image);
            } catch (error) {
                this.updateLog.log(`PULL WARN ${image}: DB update failed: ${errorMessage(error)}`);
            }
            this.events.publish('updates', 'pulled');
        }

        let latestId = '';
        try {
            const info = await this.docker.getImage(image).inspect();
            latestId = info.Id ?? '';
        } catch {
            latestId = '';
        }
        if (latestId === '' || latestId === containerImageId) {
            return { success: true, message: `${containerName} is up to date` };
        }

        const recreated = await this.runRecreate(containerName, containerId);
        this.events.publish('container', 'updated');
        if (!recreated.success) {
            return { success: false, message: `Update failed for ${containerName}: ${recreated.error}` };
        }
        await this.syncUnraidStatusAfterRecreate(image, pullDigest);
        return { success: true, message: `Updated ${containerName} to the latest ${image}` };
    }

    /**
     * `checkAllImageUpdates()`. Shared by `checkForUpdates()`,
     * `runScheduledCheck()`, and `updateContainer()` — see the class doc for
     * the split.
     *
     * `localRefs` is `checkAllImageUpdates()`'s 5th parameter: image ->
     * local image reference, checked even when no container currently lists
     * that image. Only used in targeted mode (`onlyImages !== null`), merged
     * into the container-derived map with existing entries winning, exactly
     * as PHP's `$uniqueImages += $localRefs` does. `updateContainer()` is the
     * only caller that supplies one, keyed on the tag a container was
     * created from, which Docker stops listing once the tag moves to a newer
     * build.
     *
     * `announceChecked` gates the `('updates', 'checked')` event at the end.
     * PHP never sends it from `executeContainerUpdate()` — only
     * `updates.php`'s own `handlePost()` and `check-updates.php` send it,
     * outside `checkAllImageUpdates()` itself — so `updateContainer()` is the
     * one caller that passes `false`.
     */
    private async performCheck(
        onlyImages: string[] | null,
        localRefs: Map<string, string> = new Map(),
        announceChecked = true
    ): Promise<CheckOutcome> {
        // When every requested image already carries a local reference
        // (`updateContainer()`'s single-tag call), nothing here needs the
        // container list at all — mirrors `checkAllImageUpdates()`'s $refsOnly.
        const refsOnly =
            onlyImages !== null && localRefs.size > 0 && onlyImages.every((image) => localRefs.has(image));
        const containers = refsOnly ? [] : await this.docker.listContainers({ all: true });

        // Read settings and the prior run's rows up front. DatabaseService.write()
        // holds `BEGIN IMMEDIATE` for the life of its callback, and a registry
        // request can take up to 15s each (see distributionInspect) — holding
        // that lock across N of them would starve every other writer on the box.
        // So: read once, do every Docker and registry call outside any
        // transaction, write once at the end.
        const { excludePatterns, existing } = this.db.read((db) => ({
            excludePatterns: readExcludePatterns(db),
            existing: readExistingChecks(db),
        }));

        // Unique image -> imageId, and image -> container names, mirroring
        // checkAllImageUpdates()'s loop over DockerClient::listContainers(true).
        const uniqueImages = new Map<string, string>();
        const containersByImage = new Map<string, string[]>();
        const resolved = await this.resolveListImages(containers);
        for (const container of containers) {
            const name = stripLeadingSlash(container.Names?.[0] ?? '');
            const rawImage = container.Image ?? '';
            if (rawImage === '') continue;
            const image = resolved.get(container.Id) ?? rawImage;
            if (!uniqueImages.has(image)) uniqueImages.set(image, container.ImageID ?? '');
            if (name !== '') containersByImage.set(image, [...(containersByImage.get(image) ?? []), name]);
        }

        let checkSet = uniqueImages;
        if (onlyImages !== null) {
            const merged = new Map(uniqueImages);
            for (const [image, ref] of localRefs) {
                if (!merged.has(image)) merged.set(image, ref);
            }
            const requested = new Set(onlyImages);
            checkSet = new Map([...merged].filter(([image]) => requested.has(image)));
            this.updateLog.log(
                `INFO Targeted check for ${onlyImages.length} image(s), ${checkSet.size} matched running container image(s)`
            );
        }
        this.updateLog.log(`INFO Found ${containers.length} container(s), ${checkSet.size} unique image(s)`);

        const results: DockerFoldersImageUpdateStatus[] = [];
        let checked = 0;
        let skipped = 0;
        let errors = 0;
        let newUpdates = 0;

        for (const [image, imageId] of checkSet) {
            // Skipped, and left out of the response entirely — matching PHP,
            // which never writes a row for an excluded image on this run.
            if (excludePatterns.some((pattern) => globMatch(pattern, image))) {
                this.updateLog.log(`SKIP ${image} (excluded)`);
                skipped++;
                continue;
            }

            try {
                const check = await this.checkOne(image, imageId);
                checked++;

                // Suppress false positives from a just-pulled image: if the
                // last check already found no update and the remote digest
                // has not moved since, an apparent "update" is a multi-arch
                // digest format mismatch, not a real one.
                if (check.updateAvailable && !check.error && check.remoteDigest) {
                    const last = existing.get(image);
                    if (last && !last.updateAvailable && last.remoteDigest && last.remoteDigest === check.remoteDigest) {
                        check.updateAvailable = false;
                        this.updateLog.log(`OK ${image}: remote digest unchanged since last pull, no update`);
                    }
                }

                if (check.error) {
                    this.updateLog.log(`ERROR ${image}: ${check.error}`);
                    errors++;
                } else if (check.updateAvailable) {
                    this.updateLog.log(`UPDATE ${image}: update available`);
                    newUpdates++;
                } else {
                    this.updateLog.log(`OK ${image}: up to date`);
                }

                results.push({
                    image,
                    localDigest: check.localDigest,
                    remoteDigest: check.remoteDigest,
                    updateAvailable: check.updateAvailable,
                    checkedAt: nowSeconds(),
                    error: check.error,
                    sourceUrl: check.sourceUrl,
                    sourceRepo: parseRepo(check.sourceUrl),
                    release: null,
                });
            } catch (error) {
                const message = errorMessage(error);
                this.updateLog.log(`FATAL ${image}: ${message}`);
                errors++;
                checked++;
                results.push({
                    image,
                    localDigest: null,
                    remoteDigest: null,
                    updateAvailable: false,
                    checkedAt: nowSeconds(),
                    error: message,
                    sourceUrl: null,
                    sourceRepo: null,
                    release: null,
                });
            }
        }

        this.db.write((db) => {
            const upsert = db.prepare(
                `INSERT OR REPLACE INTO image_update_checks
                    (image, local_digest, remote_digest, update_available, checked_at, error, source_url, source_repo)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const r of results) {
                upsert.run(
                    r.image,
                    r.localDigest,
                    r.remoteDigest,
                    r.updateAvailable ? 1 : 0,
                    r.checkedAt,
                    r.error,
                    r.sourceUrl,
                    r.sourceRepo
                );
            }

            // Stale cleanup only for a full check: checkSet only holds the
            // requested subset for a targeted one, and this NOT-IN would wipe
            // every other cached row.
            if (onlyImages === null && checkSet.size > 0) {
                const currentImages = [...checkSet.keys()];
                const placeholders = currentImages.map(() => '?').join(',');
                const staleCount = db
                    .prepare(`SELECT COUNT(*) AS count FROM image_update_checks WHERE image NOT IN (${placeholders})`)
                    .get(...currentImages) as { count: number };
                if (staleCount.count > 0) {
                    db.prepare(`DELETE FROM image_update_checks WHERE image NOT IN (${placeholders})`).run(
                        ...currentImages
                    );
                    this.updateLog.log(`CLEANUP Removed ${staleCount.count} stale image_update_checks entries`);
                }
            }
        });

        // Clear Unraid flags that pulls made before issue #23's fix left
        // stale. Full checks only, like the cleanup above.
        if (onlyImages === null) {
            try {
                const candidates = containers.map((c) => ({
                    name: stripLeadingSlash(c.Names?.[0] ?? ''),
                    image: resolved.get(c.Id) ?? c.Image ?? '',
                    imageId: c.ImageID ?? '',
                }));
                const repaired = await repairUnraidUpdateStatus(
                    async (key) => {
                        try {
                            const info = await this.docker.getImage(key).inspect();
                            return { id: info.Id ?? '', repoDigests: info.RepoDigests ?? [] };
                        } catch {
                            return null;
                        }
                    },
                    candidates,
                    this.unraidPaths
                );
                for (const key of repaired) this.updateLog.log(`UNRAID Repaired stale update flag for ${key}`);
            } catch (error) {
                this.updateLog.log(`UNRAID WARN repair failed: ${errorMessage(error)}`);
            }
        }

        // Release notes are a nice-to-have layered on top of a complete check.
        // Any failure here must leave the digest results and counters above
        // exactly as they are.
        try {
            await this.releaseNotes.refresh(results, onlyImages === null);
        } catch (error) {
            this.updateLog.log(`NOTES FATAL ${errorMessage(error)}`);
        }

        if (announceChecked) this.events.publish('updates', 'checked');

        return { results, containersByImage, existingBefore: existing, checked, skipped, errors, newUpdates };
    }

    /** `DockerClient::checkImageUpdate`. */
    private async checkOne(image: string, imageId: string): Promise<OneImageCheck> {
        let localDigest: string | null = null;
        let sourceUrl: string | null = null;

        if (imageId !== '') {
            try {
                const info = await this.docker.getImage(imageId).inspect();
                const digests = info.RepoDigests ?? [];
                localDigest = digests.length > 0 ? digests[0] : null;

                const src = info.Config?.Labels?.[SOURCE_LABEL];
                if (typeof src === 'string' && /^https?:\/\//i.test(src)) {
                    sourceUrl = src.replace(/\/+$/, '');
                }
            } catch (error) {
                // Mirrors PHP: an inspect failure here silently leaves the
                // local digest and source label unset. It is not surfaced as
                // this image's `error` — only a failed remote lookup is.
                this.logger.warn(`Could not inspect local image ${imageId} for ${image}: ${errorMessage(error)}`);
            }
        }

        let remoteDigest: string | null = null;
        try {
            const distribution = await this.docker.distributionInspect(image);
            remoteDigest = distribution.Descriptor?.digest ?? null;
        } catch {
            remoteDigest = null;
        }

        if (remoteDigest === null) {
            return {
                localDigest,
                remoteDigest: null,
                updateAvailable: false,
                sourceUrl,
                error: 'Failed to fetch remote digest',
            };
        }

        // Local RepoDigest format is "name@sha256:abc...", remote is bare "sha256:abc...".
        let updateAvailable = false;
        if (localDigest) {
            const at = localDigest.indexOf('@');
            const localHash = at !== -1 ? localDigest.slice(at + 1) : localDigest;
            updateAvailable = localHash !== remoteDigest;
        }

        return { localDigest, remoteDigest, updateAvailable, sourceUrl, error: null };
    }

    /** Validates image/containers/recreate exactly like `pull.php`'s top-of-file checks. */
    private validatePullRequest(
        image: string,
        options?: PullOptions
    ): { onlyContainerIds: Set<string> | null; forceRecreate: boolean; recreateOnly: boolean } {
        if (!IMAGE_NAME_PATTERN.test(image) || image.length > MAX_IMAGE_NAME_LENGTH) {
            throw new BadRequestException('Invalid image name');
        }

        let onlyContainerIds: Set<string> | null = null;
        const rawContainers = options?.containers ?? [];
        if (rawContainers.length > 0) {
            const ids = rawContainers.map((id) => id.trim()).filter((id) => CONTAINER_ID_PATTERN.test(id));
            if (ids.length === 0) {
                throw new BadRequestException('Invalid container IDs');
            }
            onlyContainerIds = new Set(ids);
        }

        const forceRecreate = options?.recreate === true;
        if (forceRecreate && onlyContainerIds === null) {
            throw new BadRequestException('recreate requires containers');
        }

        const recreateOnly = options?.recreateOnly === true;
        if (recreateOnly && onlyContainerIds === null) {
            throw new BadRequestException('recreateOnly requires containers');
        }

        return { onlyContainerIds, forceRecreate, recreateOnly };
    }

    /**
     * The pull-and-consume half of `pull.php`'s body: fetch the layer stream
     * and read it to completion, reporting failure the way `runPull()` does —
     * a fixed `'Pull failed'` for a transport-level failure, or the stream's
     * own error line when Docker's response carries one.
     *
     * Shared by `runPull()` (which layers the cache update, events, and
     * `post_pull_action` on top) and `updateContainer()` (which pulls the
     * same way but skips all of that — see that method's doc comment).
     */
    private async pullOnly(
        image: string,
        emit: (event: DockerFoldersPullEvent) => void
    ): Promise<{ success: boolean; error: string | null; digest: string | null }> {
        let stream: NodeJS.ReadableStream;
        try {
            stream = await this.docker.pullImage(image);
        } catch (error) {
            // Keep the daemon's own text, matching PHP's curl_error(): a
            // reason belongs in "Pull failed for N: <reason>" history, and
            // the fixed message is only for when there is no reason to show.
            const reason = errorMessage(error);
            this.logger.warn(`Docker pull error for ${image}: ${reason}`);
            this.updateLog.log(`PULL FAIL ${image}`);
            return { success: false, error: reason || 'Pull failed', digest: null };
        }

        let streamError: string | null;
        let digest: string | null;
        try {
            ({ error: streamError, digest } = await this.consumeChunksWithTimeout(stream, emit));
        } catch (error) {
            const reason = errorMessage(error);
            this.logger.warn(`Docker pull stream error for ${image}: ${reason}`);
            this.updateLog.log(`PULL FAIL ${image}`);
            return { success: false, error: reason || 'Pull failed', digest: null };
        }

        if (streamError !== null) {
            // Deliberate divergence from PHP: PHP's success flag is purely the
            // curl HTTP status, so a stream that carries a fatal
            // `{"error": ...}` line (e.g. "manifest unknown") while the HTTP
            // response itself was 200 still reports success. This treats that
            // line as the failure it describes instead.
            this.updateLog.log(`PULL FAIL ${image}: ${streamError}`);
            return { success: false, error: streamError, digest: null };
        }

        return { success: true, error: null, digest };
    }

    /** `pull.php`'s whole body, minus SSE framing — `emit` takes its place. */
    /** `pull.php`'s `recreate_only=1` branch: no pull, only the recreate. */
    private async runRecreateOnly(
        image: string,
        onlyContainerIds: Set<string>,
        emit: (event: DockerFoldersPullEvent) => void
    ): Promise<DockerFoldersImagePullResult> {
        this.updateLog.log(`RECREATE ONLY ${image}`);
        emit({ type: 'status', message: 'Recreating...' });
        await this.autoRecreate(image, onlyContainerIds, emit, null);
        this.events.publish('container', 'updated');
        return { success: true, image, error: null };
    }

    private async runPull(
        image: string,
        onlyContainerIds: Set<string> | null,
        forceRecreate: boolean,
        emit: (event: DockerFoldersPullEvent) => void
    ): Promise<DockerFoldersImagePullResult> {
        emit({ type: 'status', message: `Pulling ${image}...` });

        const pulled = await this.pullOnly(image, emit);
        if (!pulled.success) {
            return { success: false, image, error: pulled.error };
        }

        this.updateLog.log(`PULL OK ${image}`);

        // Post-pull digest refresh is non-critical, matching PHP's own
        // try/catch around it: a failure here must not turn a pull that
        // succeeded into a result that reports failure.
        try {
            await this.recordPulled(image);
        } catch (error) {
            this.updateLog.log(`PULL WARN ${image}: DB update failed: ${errorMessage(error)}`);
        }

        this.events.publish('updates', 'pulled');
        this.events.publish('container', 'updated');

        let postPullAction = 'pull_only';
        try {
            postPullAction = this.db.read((db) => readPostPullAction(db));
        } catch (error) {
            this.updateLog.log(`PULL WARN ${image}: Settings fetch failed: ${errorMessage(error)}`);
        }
        this.updateLog.log(`PULL post_pull_action=${postPullAction} for ${image}`);

        if (postPullAction === 'pull_and_auto_recreate' || forceRecreate) {
            await this.autoRecreate(image, onlyContainerIds, emit, pulled.digest);
        }

        return { success: true, image, error: null };
    }

    /**
     * Parses Docker's newline-delimited-JSON pull progress, the way
     * `DockerClient::pullImage`'s `CURLOPT_WRITEFUNCTION` does, emitting a
     * `progress` event per line and an `error` event for any line that
     * carries one. Resolves with the last such error message, or null when
     * none appeared — `runPull` decides what that means for the overall
     * result.
     */
    private consumeChunks(
        stream: NodeJS.ReadableStream,
        emit: (event: DockerFoldersPullEvent) => void
    ): Promise<PullStreamOutcome> {
        return new Promise((resolve, reject) => {
            let buffer = '';
            let lastError: string | null = null;
            // The "Digest: sha256:..." line, the digest Unraid's updater records.
            let digest: string | null = null;

            stream.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === '') continue;

                    let parsed: {
                        id?: string;
                        status?: string;
                        progressDetail?: { current?: number; total?: number };
                        error?: string;
                    };
                    try {
                        parsed = JSON.parse(trimmed) as typeof parsed;
                    } catch {
                        // Docker sends one JSON object per line; an
                        // unparseable one is dropped, the same way
                        // DockerClient::pullImage's `json_decode(...) !== null`
                        // guard silently skips it.
                        continue;
                    }

                    digest = pullDigestFromStatus(parsed.status) ?? digest;

                    if (typeof parsed.error === 'string' && parsed.error !== '') {
                        lastError = parsed.error;
                        emit({ type: 'error', message: parsed.error });
                        continue;
                    }

                    emit({
                        type: 'progress',
                        id: parsed.id ?? '',
                        status: parsed.status ?? '',
                        current: parsed.progressDetail?.current ?? null,
                        total: parsed.progressDetail?.total ?? null,
                    });
                }
            });

            stream.on('error', (error: Error) => reject(error));
            stream.on('end', () => resolve({ error: lastError, digest }));
        });
    }

    /**
     * `consumeChunks`, bounded the way `DockerClient::pullImage`'s
     * `CURLOPT_TIMEOUT` bounds the whole curl handle — not a per-chunk
     * timeout, but a ceiling on the entire pull. Past it, the stream is
     * destroyed with an error, which `consumeChunks`' own `'error'` listener
     * turns into a rejection carrying that error's message. The timer is
     * cleared as soon as `consumeChunks` settles, on either 'end' or 'error'.
     */
    private consumeChunksWithTimeout(
        stream: NodeJS.ReadableStream,
        emit: (event: DockerFoldersPullEvent) => void
    ): Promise<PullStreamOutcome> {
        const destroyable = stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
        const timer = setTimeout(() => {
            destroyable.destroy?.(new Error('Pull timed out'));
        }, PULL_TIMEOUT_MS);

        return this.consumeChunks(stream, emit).finally(() => clearTimeout(timer));
    }

    /**
     * `pull.php`'s post-pull cache update. `source_url`/`source_repo` are
     * deliberately left out of the write so a prior check's values survive —
     * PHP's `INSERT OR REPLACE` here nulls both columns instead, which is a
     * bug (reported, not fixed): the update confirm modal loses its release
     * notes link for that image until the next full check overwrites the row.
     */
    private async recordPulled(image: string): Promise<void> {
        const remoteDigest = await this.docker
            .distributionInspect(image)
            .then((info) => info.Descriptor?.digest ?? null)
            .catch(() => null);

        let localDigest: string | null = null;
        try {
            const info = await this.docker.getImage(image).inspect();
            const digests = info.RepoDigests ?? [];
            localDigest = digests.length > 0 ? digests[0] : null;
        } catch (error) {
            this.logger.warn(`Could not read local digest for ${image}: ${errorMessage(error)}`);
        }

        this.db.write((db) => {
            db.prepare(
                `INSERT INTO image_update_checks
                    (image, local_digest, remote_digest, update_available, checked_at, error, source_url, source_repo)
                 VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL)
                 ON CONFLICT(image) DO UPDATE SET
                    local_digest = excluded.local_digest,
                    remote_digest = excluded.remote_digest,
                    update_available = 0,
                    checked_at = excluded.checked_at,
                    error = NULL`
            ).run(image, localDigest, remoteDigest, nowSeconds());
        });

        this.updateLog.log(`PULL DB updated ${image}: local=${localDigest ?? ''}, remote=${remoteDigest ?? ''}`);
    }

    /**
     * `syncUnraidStatusAfterRecreate()` in `config.php` (issue #23): after a
     * recreate, mark the tag current in Unraid's own files, but only once
     * every container on the tag runs its image. A pull alone never does.
     * Never throws.
     *
     * @param pullDigest The pull stream's `Digest:` line when this request pulled
     */
    private async syncUnraidStatusAfterRecreate(image: string, pullDigest: string | null): Promise<void> {
        try {
            let info: { Id?: string; RepoDigests?: string[] };
            try {
                info = await this.docker.getImage(image).inspect();
            } catch {
                this.updateLog.log(`RECREATE UNRAID skip ${image}: image not found`);
                return;
            }
            const imageId = info.Id ?? '';
            if (imageId === '') {
                this.updateLog.log(`RECREATE UNRAID skip ${image}: image not found`);
                return;
            }

            const containers = await this.recreateCandidates();
            const behind = containersBehindImage(containers, image, imageId);
            if (behind.length > 0) {
                this.updateLog.log(`RECREATE UNRAID skip ${image}: still on the old image: ${behind.join(', ')}`);
                return;
            }

            const remote = await this.docker
                .distributionInspect(image)
                .then((d) => d.Descriptor?.digest ?? null)
                .catch(() => null);
            const stored = this.db.read(
                (db) =>
                    db.prepare('SELECT remote_digest FROM image_update_checks WHERE image = ?').get(image) as
                        | { remote_digest: string | null }
                        | undefined
            );
            const digest = pickUnraidDigest(pullDigest, info.RepoDigests ?? [], [remote, stored?.remote_digest ?? null]);

            const names = containerNamesForImage(containers, image);
            if (markUnraidImageCurrent(image, digest, names, this.unraidPaths)) {
                this.updateLog.log(
                    `RECREATE UNRAID status updated ${unraidImageKey(image) ?? image}: ${digest ?? ''}` +
                        (names.length > 0 ? ` (${names.join(', ')})` : '')
                );
            } else {
                this.updateLog.log(
                    `RECREATE UNRAID status not updated for ${image}: no digest, or the file could not be read`
                );
            }
        } catch (error) {
            this.updateLog.log(`RECREATE WARN ${image}: Unraid status update failed: ${errorMessage(error)}`);
        }
    }

    /** The `post_pull_action`/`forceRecreate` block of `pull.php`. */
    private async autoRecreate(
        image: string,
        onlyContainerIds: Set<string> | null,
        emit: (event: DockerFoldersPullEvent) => void,
        pullDigest: string | null
    ): Promise<void> {
        try {
            const selection = selectRecreateTargets(await this.recreateCandidates(), image, onlyContainerIds);
            const matching = selection.targets;

            this.updateLog.log(`RECREATE Found ${matching.length} container(s) using ${image}`);

            for (const missingId of selection.missing) {
                const shortId = missingId.slice(0, 12);
                this.updateLog.log(`RECREATE SKIP ${shortId}: not found, or no longer uses ${image}`);
                emit({
                    type: 'recreate_error',
                    container: shortId,
                    message: `Container ${shortId} was not recreated: it no longer exists or does not use ${image}`,
                });
            }

            let anyRecreated = false;
            for (const container of matching) {
                const { name, id } = container;

                emit({ type: 'recreating', container: name, message: `Recreating ${name}...` });

                const result = await this.runRecreate(name, id);
                if (result.success) {
                    anyRecreated = true;
                    emit({ type: 'recreated', container: name, message: `${name} updated successfully` });
                } else {
                    emit({
                        type: 'recreate_error',
                        container: name,
                        message: `Failed to recreate ${name}: ${result.error}`,
                    });
                }
            }

            if (anyRecreated) await this.syncUnraidStatusAfterRecreate(image, pullDigest);
        } catch (error) {
            const message = errorMessage(error);
            this.updateLog.log(`RECREATE ERROR ${image}: ${message}`);
            emit({ type: 'recreate_error', container: '', message: `Recreate failed: ${message}` });
        }
    }

    /**
     * Each container's image, id => reference, resolved the way the container
     * list and PHP's `DockerClient::listContainers()` resolve it. Docker's list
     * carries no `Config`, so a container listed under a bare `sha256:` id with
     * no Unraid template is inspected for its `Config.Image`. Those are only
     * the containers whose tag already moved, so a settled server inspects
     * none.
     */
    private async resolveListImages(containers: DockerListContainer[]): Promise<Map<string, string>> {
        const entries = await Promise.all(
            containers.map(async (container): Promise<[string, string]> => {
                const name = stripLeadingSlash(container.Names?.[0] ?? '');
                const listImage = container.Image ?? '';
                let image = resolveImageTag(listImage, name);
                if (image.startsWith('sha256:')) {
                    try {
                        const inspect = await this.docker.getContainer(container.Id).inspect();
                        image = resolveImageTag(listImage, name, inspect.Config?.Image ?? '');
                    } catch (error) {
                        this.logger.warn(`Could not inspect container ${name}: ${errorMessage(error)}`);
                    }
                }
                return [container.Id, image];
            })
        );
        return new Map(entries);
    }

    /** Every container, with its image resolved by `resolveListImages()`. */
    private async recreateCandidates(): Promise<RecreateCandidate[]> {
        const containers = await this.docker.listContainers({ all: true });
        const resolved = await this.resolveListImages(containers);
        return containers.map((container) => ({
            id: container.Id,
            name: stripLeadingSlash(container.Names?.[0] ?? ''),
            image: resolved.get(container.Id) ?? container.Image ?? '',
            imageId: container.ImageID ?? '',
        }));
    }

    /**
     * Recreate one container, with the update log lines `autoRecreate()` and
     * `updateContainer()` share — `recreateOneContainer()` in `config.php`.
     * `error` is never null on failure: it defaults to 'Unknown error' the
     * same way PHP's caller-side `$result['error'] ?? 'Unknown error'` did,
     * so every caller can use it directly in a message.
     */
    private async runRecreate(name: string, id: string): Promise<RecreateResult> {
        this.updateLog.log(`RECREATE Starting recreate for ${name} (${id})`);
        const result = await this.recreate.recreateContainer(id);
        if (result.success) {
            this.updateLog.log(`RECREATE OK ${name} -> new ID ${result.newId}`);
            return result;
        }
        const error = result.error ?? 'Unknown error';
        this.updateLog.log(`RECREATE FAIL ${name}: ${error}`);
        return { ...result, error };
    }
}
