import { PassThrough } from 'node:stream';

import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    DockerClient,
    DockerDistributionInfo,
    DockerListContainer,
} from '../../containers/docker-client.js';
import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import type { RecreateResult, RecreateService } from '../recreate.service.js';
import { ReleaseNotesService, type ReleaseFetcher } from '../release-notes.service.js';
import { UpdateLogService } from '../update-log.service.js';
import { UpdatesService } from '../updates.service.js';

const PLEX = 'linuxserver/plex:latest';
const PLEX_IMAGE_ID = 'sha256:image-plex';
const SONARR = 'linuxserver/sonarr:latest';
const SONARR_IMAGE_ID = 'sha256:image-sonarr';

/**
 * A stand-in for dockerode, narrow enough to hand-drive digests per image
 * without a Docker socket. `containers` seeds `listContainers`; digests and
 * failures are per-image maps a test can mutate before calling the service.
 */
function fakeDocker() {
    let containers: DockerListContainer[] = [];
    const localDigests = new Map<string, string[]>();
    const remoteDigests = new Map<string, string>();
    const remoteFailures = new Map<string, Error>();
    const labels = new Map<string, Record<string, string>>();
    const pullStreams = new Map<string, PassThrough>();
    const pullFailures = new Map<string, Error>();
    const calls: string[] = [];

    const client: DockerClient = {
        listContainers: async () => {
            calls.push('listContainers');
            return containers;
        },
        getContainer: () => {
            throw new Error('not used here');
        },
        getImage: (id: string) => ({
            inspect: async () => {
                calls.push(`inspect ${id}`);
                return {
                    RepoDigests: localDigests.get(id) ?? [],
                    Config: { Labels: labels.get(id) ?? {} },
                };
            },
            remove: () => Promise.reject(new Error('not used here')),
        }),
        getEvents: () => Promise.reject(new Error('not used here')),
        distributionInspect: async (imageRef: string): Promise<DockerDistributionInfo> => {
            calls.push(`distributionInspect ${imageRef}`);
            const failure = remoteFailures.get(imageRef);
            if (failure) throw failure;
            const digest = remoteDigests.get(imageRef);
            return { Descriptor: digest ? { digest } : null };
        },
        pullImage: async (imageRef: string) => {
            calls.push(`pullImage ${imageRef}`);
            const failure = pullFailures.get(imageRef);
            if (failure) throw failure;
            const stream = new PassThrough();
            pullStreams.set(imageRef, stream);
            return stream;
        },
    };

    return {
        client,
        calls,
        setContainers: (value: DockerListContainer[]) => {
            containers = value;
        },
        setLocalDigests: (imageId: string, digests: string[]) => localDigests.set(imageId, digests),
        setLabels: (imageId: string, value: Record<string, string>) => labels.set(imageId, value),
        setRemoteDigest: (image: string, digest: string) => remoteDigests.set(image, digest),
        failRemote: (image: string, error: Error) => remoteFailures.set(image, error),
        failPull: (image: string, error: Error) => pullFailures.set(image, error),
        streamFor: (image: string) => {
            const stream = pullStreams.get(image);
            if (!stream) throw new Error(`no pull stream for ${image}`);
            return stream;
        },
    };
}

function fakeEvents() {
    return { publish: vi.fn() } as unknown as EventBusService;
}

/** A silent stand-in — asserting on log text is `UpdateLogService`'s own test's job. */
function fakeUpdateLog() {
    return { log: vi.fn() } as unknown as UpdateLogService;
}

/**
 * A real `ReleaseNotesService` (so the DB join under test is the real one),
 * with a fetcher that fails the test if it is ever actually called. Per-test
 * setup that has an image with both `updateAvailable: true` and a
 * `sourceRepo` would call it for real otherwise — this is the guard against
 * that happening by accident.
 */
function releaseNotesServiceThatNeverFetches(dbPath: string, log: UpdateLogService): ReleaseNotesService {
    const fetcher: ReleaseFetcher = () => {
        throw new Error('the GitHub fetcher must not be called in these tests');
    };
    return new ReleaseNotesService(new DatabaseService(dbPath), log, fetcher);
}

function fakeRecreate(results: Map<string, RecreateResult> = new Map()) {
    const calls: string[] = [];
    const service = {
        recreateContainer: async (id: string) => {
            calls.push(id);
            return results.get(id) ?? { success: true, newId: `new-${id}`, error: null };
        },
    } as unknown as RecreateService;
    return { service, calls };
}

/**
 * Fixed, valid-hex ids (matching `CONTAINER_ID_PATTERN`) for the containers
 * these tests use — a `docker.listContainers()` id is a real hex string, and
 * the `containers=` validation in `pull.php` requires one too, so a fake
 * `"id-plex"` would fail validation before ever being compared against.
 */
const CONTAINER_IDS: Record<string, string> = {
    plex: 'aaaaaaaaaaaa',
    plex2: 'bbbbbbbbbbbb',
    sonarr: 'cccccccccccc',
};

function container(name: string, image: string, imageId: string): DockerListContainer {
    return { Id: CONTAINER_IDS[name] ?? name, Names: [`/${name}`], Image: image, ImageID: imageId };
}

describe('UpdatesService', () => {
    let temp: TempDatabase;
    let docker: ReturnType<typeof fakeDocker>;
    let events: EventBusService;
    let updateLog: UpdateLogService;
    let recreate: ReturnType<typeof fakeRecreate>;
    let service: UpdatesService;

    beforeEach(() => {
        temp = createMigratedDatabase();
        docker = fakeDocker();
        events = fakeEvents();
        updateLog = fakeUpdateLog();
        recreate = fakeRecreate();
        service = new UpdatesService(
            docker.client,
            new DatabaseService(temp.path),
            events,
            updateLog,
            releaseNotesServiceThatNeverFetches(temp.path, updateLog),
            recreate.service
        );
    });

    afterEach(() => {
        temp.cleanup();
    });

    describe('checkForUpdates', () => {
        it('reports an update when the local and remote digests differ', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setLocalDigests(PLEX_IMAGE_ID, [`${PLEX}@sha256:old`]);
            docker.setRemoteDigest(PLEX, 'sha256:new');

            const results = await service.checkForUpdates();

            expect(results).toEqual([
                expect.objectContaining({ image: PLEX, updateAvailable: true, error: null }),
            ]);
        });

        it('reports no update when the digests match', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setLocalDigests(PLEX_IMAGE_ID, [`${PLEX}@sha256:same`]);
            docker.setRemoteDigest(PLEX, 'sha256:same');

            const [result] = await service.checkForUpdates();

            expect(result.updateAvailable).toBe(false);
        });

        it('suppresses a stale update when the remote digest has not moved since the last no-update check', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            // Local RepoDigest still carries the old hash (e.g. multi-arch
            // format mismatch), but the remote digest is unchanged from a
            // prior check that already found no update.
            docker.setLocalDigests(PLEX_IMAGE_ID, [`${PLEX}@sha256:mismatched-local-format`]);
            docker.setRemoteDigest(PLEX, 'sha256:same-remote');
            new DatabaseService(temp.path).write((db) => {
                db.prepare(
                    `INSERT INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at)
                     VALUES (?, NULL, ?, 0, 0)`
                ).run(PLEX, 'sha256:same-remote');
            });

            const [result] = await service.checkForUpdates();

            expect(result.updateAvailable).toBe(false);
        });

        it('reports an error and no update when the remote digest cannot be fetched', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.failRemote(PLEX, new Error('network unreachable'));

            const [result] = await service.checkForUpdates();

            expect(result).toEqual(
                expect.objectContaining({
                    updateAvailable: false,
                    error: 'Failed to fetch remote digest',
                })
            );
        });

        it('skips an excluded image entirely, leaving it out of the response', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:new');
            new DatabaseService(temp.path).write((db) => {
                db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('update_check_exclude', ?, 0)").run(
                    'linuxserver/*'
                );
            });

            const results = await service.checkForUpdates();

            expect(results).toEqual([]);
            expect(docker.calls).not.toContain(`distributionInspect ${PLEX}`);
        });

        it('restricts a targeted check to the requested images, and leaves other cached rows alone', async () => {
            docker.setContainers([
                container('plex', PLEX, PLEX_IMAGE_ID),
                container('sonarr', SONARR, SONARR_IMAGE_ID),
            ]);
            docker.setRemoteDigest(PLEX, 'sha256:new-plex');
            docker.setRemoteDigest(SONARR, 'sha256:new-sonarr');
            new DatabaseService(temp.path).write((db) => {
                db.prepare(
                    `INSERT INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at)
                     VALUES ('registry/untouched:latest', NULL, NULL, 0, 0)`
                ).run();
            });

            const results = await service.checkForUpdates([PLEX]);

            expect(results.map((r) => r.image)).toEqual([PLEX]);
            expect(docker.calls).not.toContain(`distributionInspect ${SONARR}`);
            // A targeted check must not run the stale-row cleanup.
            expect(temp.rows("SELECT image FROM image_update_checks WHERE image = 'registry/untouched:latest'")).toHaveLength(1);
        });

        it('rejects a targeted check with no non-empty image names', async () => {
            // Matches PHP's filter exactly: it checks for an empty string,
            // not whitespace, so this (not a blank-string case) is the one
            // that must fail.
            await expect(service.checkForUpdates(['', ''])).rejects.toThrow(BadRequestException);
        });

        it('removes cached rows for images no container uses any more, on a full check only', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:same');
            docker.setLocalDigests(PLEX_IMAGE_ID, [`${PLEX}@sha256:same`]);
            new DatabaseService(temp.path).write((db) => {
                db.prepare(
                    `INSERT INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at)
                     VALUES ('registry/gone:latest', NULL, NULL, 0, 0)`
                ).run();
            });

            await service.checkForUpdates();

            expect(temp.rows('SELECT image FROM image_update_checks').map((r) => r.image)).toEqual([PLEX]);
        });

        it('announces "updates checked" exactly once per call, even for a targeted check', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:x');

            await service.checkForUpdates([PLEX]);

            expect(events.publish).toHaveBeenCalledWith('updates', 'checked');
            expect((events.publish as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
        });

        it('joins a cached release note only when its status is ok', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setLabels(PLEX_IMAGE_ID, {
                'org.opencontainers.image.source': 'https://github.com/linuxserver/docker-plex',
            });
            docker.setRemoteDigest(PLEX, 'sha256:x');
            new DatabaseService(temp.path).write((db) => {
                db.prepare(
                    `INSERT INTO release_notes (repo, tag, name, published_at, url, summary, status, fetched_at)
                     VALUES ('linuxserver/docker-plex', 'v1.2.3', 'v1.2.3', 100, 'https://x', 'notes', 'ok', 200)`
                ).run();
            });

            const [result] = await service.checkForUpdates();

            expect(result.sourceRepo).toBe('linuxserver/docker-plex');
            expect(result.release).toEqual(
                expect.objectContaining({ tag: 'v1.2.3', fetchedAt: 200 })
            );
        });
    });

    describe('getCached', () => {
        it('reads back what a check wrote, including a null release for a not_found note', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setLabels(PLEX_IMAGE_ID, {
                'org.opencontainers.image.source': 'https://github.com/linuxserver/docker-plex',
            });
            docker.setRemoteDigest(PLEX, 'sha256:x');
            new DatabaseService(temp.path).write((db) => {
                db.prepare(
                    `INSERT INTO release_notes (repo, status, fetched_at)
                     VALUES ('linuxserver/docker-plex', 'not_found', 100)`
                ).run();
            });

            await service.checkForUpdates();
            const cached = service.getCached();

            expect(cached).toEqual([expect.objectContaining({ image: PLEX, release: null })]);
        });
    });

    describe('pullImage', () => {
        it('rejects a malformed image name before ever touching Docker', async () => {
            await expect(service.pullImage('../etc/passwd')).rejects.toThrow(BadRequestException);
            expect(docker.calls).toEqual([]);
        });

        it('rejects recreate:true without containerIds', async () => {
            await expect(service.pullImage(PLEX, { recreate: true })).rejects.toThrow(BadRequestException);
        });

        it('rejects a containers list with no valid ids', async () => {
            await expect(service.pullImage(PLEX, { containers: ['not-an-id'] })).rejects.toThrow(
                BadRequestException
            );
        });

        it('reports success, updates the cache, and announces both events', async () => {
            docker.setRemoteDigest(PLEX, 'sha256:pulled');

            const promise = service.pullImage(PLEX);
            docker.streamFor(PLEX).end('{"status":"Pull complete"}\n');
            const result = await promise;

            expect(result).toEqual({ success: true, image: PLEX, error: null });
            expect(events.publish).toHaveBeenCalledWith('updates', 'pulled');
            expect(events.publish).toHaveBeenCalledWith('container', 'updated');
            expect(temp.rows('SELECT update_available FROM image_update_checks WHERE image = ?', [PLEX])).toEqual([
                { update_available: 0 },
            ]);
        });

        it('preserves a previously known source_repo across a pull, unlike the PHP INSERT OR REPLACE', async () => {
            docker.setRemoteDigest(PLEX, 'sha256:pulled');
            new DatabaseService(temp.path).write((db) => {
                db.prepare(
                    `INSERT INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at, source_url, source_repo)
                     VALUES (?, NULL, NULL, 1, 0, 'https://github.com/linuxserver/docker-plex', 'linuxserver/docker-plex')`
                ).run(PLEX);
            });

            const promise = service.pullImage(PLEX);
            docker.streamFor(PLEX).end('');
            await promise;

            expect(temp.rows('SELECT source_repo FROM image_update_checks WHERE image = ?', [PLEX])).toEqual([
                { source_repo: 'linuxserver/docker-plex' },
            ]);
        });

        it('fails generically when the daemon never starts the pull, matching PHP\'s HTTP-status-only success flag', async () => {
            docker.failPull(PLEX, new Error('no such image'));

            const result = await service.pullImage(PLEX);

            expect(result).toEqual({ success: false, image: PLEX, error: 'Pull failed' });
            expect(events.publish).not.toHaveBeenCalled();
        });

        it('fails when the stream reports a mid-pull error, without writing the cache (deliberate PHP divergence)', async () => {
            const promise = service.pullImage(PLEX);
            docker.streamFor(PLEX).end('{"error":"manifest unknown"}\n');

            const result = await promise;

            expect(result).toEqual({ success: false, image: PLEX, error: 'manifest unknown' });
            expect(events.publish).not.toHaveBeenCalled();
            expect(temp.rows('SELECT * FROM image_update_checks')).toEqual([]);
        });

        it('auto-recreates matching containers when post_pull_action says to', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID), container('sonarr', SONARR, SONARR_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:pulled');
            new DatabaseService(temp.path).write((db) => {
                db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('post_pull_action', 'pull_and_auto_recreate', 0)").run();
            });

            const promise = service.pullImage(PLEX);
            docker.streamFor(PLEX).end('');
            const result = await promise;

            expect(result.success).toBe(true);
            expect(recreate.calls).toEqual([CONTAINER_IDS.plex]);
        });

        it('does not auto-recreate when post_pull_action is pull_only', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:pulled');

            const promise = service.pullImage(PLEX);
            docker.streamFor(PLEX).end('');
            await promise;

            expect(recreate.calls).toEqual([]);
        });

        it('force-recreates only the requested container ids', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID), container('plex2', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:pulled');

            const promise = service.pullImage(PLEX, {
                containers: [CONTAINER_IDS.plex2],
                recreate: true,
            });
            docker.streamFor(PLEX).end('');
            await promise;

            // Only the requested id is recreated, not every container sharing the image.
            expect(recreate.calls).toEqual([CONTAINER_IDS.plex2]);
        });
    });

    describe('pullImageEvents', () => {
        it('emits status, progress, complete, then done, in that order', async () => {
            docker.setRemoteDigest(PLEX, 'sha256:pulled');

            const seen: string[] = [];
            const done = new Promise<void>((resolve) => {
                service.pullImageEvents(PLEX).subscribe({
                    next: (event) => {
                        seen.push(event.type);
                        if (event.type === 'done') resolve();
                    },
                });
            });

            // Subscribing starts the pull synchronously (cold observable), so
            // the stream exists by the time this runs.
            docker.streamFor(PLEX).end('{"id":"layer1","status":"Downloading"}\n');
            await done;

            expect(seen).toEqual(['status', 'progress', 'complete', 'done']);
        });

        it('emits error then done on failure, never complete', async () => {
            docker.failPull(PLEX, new Error('no such image'));

            const seen: string[] = [];
            const done = new Promise<void>((resolve) => {
                service.pullImageEvents(PLEX).subscribe({
                    next: (event) => {
                        seen.push(event.type);
                        if (event.type === 'done') resolve();
                    },
                });
            });
            await done;

            expect(seen).toEqual(['status', 'error', 'done']);
        });
    });

    describe('runScheduledCheck', () => {
        it('skips entirely when the Docker socket is not present', async () => {
            const withMissingSocket = new UpdatesService(
                docker.client,
                new DatabaseService(temp.path),
                events,
                updateLog,
                releaseNotesServiceThatNeverFetches(temp.path, updateLog),
                recreate.service,
                '/no/such/socket'
            );

            await withMissingSocket.runScheduledCheck();

            expect(docker.calls).toEqual([]);
            expect(updateLog.log).toHaveBeenCalledWith('SKIP Docker socket not available');
        });

        it('runs the full check when the socket path exists, using it as a stand-in file', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:new');
            const withRealSocket = new UpdatesService(
                docker.client,
                new DatabaseService(temp.path),
                events,
                updateLog,
                releaseNotesServiceThatNeverFetches(temp.path, updateLog),
                recreate.service,
                temp.path // any existing file stands in for the socket path
            );

            await withRealSocket.runScheduledCheck();

            expect(temp.rows('SELECT image FROM image_update_checks')).toEqual([{ image: PLEX }]);
            expect(events.publish).toHaveBeenCalledWith('updates', 'checked');
        });

        it('sends a notification only for images that were not already flagged, when enabled', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID), container('sonarr', SONARR, SONARR_IMAGE_ID)]);
            docker.setLocalDigests(PLEX_IMAGE_ID, [`${PLEX}@sha256:old-plex`]);
            docker.setRemoteDigest(PLEX, 'sha256:new-plex'); // newly available this run
            docker.setLocalDigests(SONARR_IMAGE_ID, [`${SONARR}@sha256:old-sonarr`]);
            docker.setRemoteDigest(SONARR, 'sha256:already-known'); // already flagged before this run, digest unchanged
            new DatabaseService(temp.path).write((db) => {
                db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('notify_on_updates', '1', 0)").run();
                db.prepare(
                    `INSERT INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at)
                     VALUES (?, NULL, 'sha256:already-known', 1, 0)`
                ).run(SONARR);
            });
            const withRealSocket = new UpdatesService(
                docker.client,
                new DatabaseService(temp.path),
                events,
                updateLog,
                releaseNotesServiceThatNeverFetches(temp.path, updateLog),
                recreate.service,
                temp.path
            );

            await withRealSocket.runScheduledCheck();

            expect(updateLog.log).toHaveBeenCalledWith(expect.stringContaining('NOTIFY Sent notification: 1 container update available (plex)'));
        });

        it('sends no notification when disabled, even with new updates', async () => {
            docker.setContainers([container('plex', PLEX, PLEX_IMAGE_ID)]);
            docker.setRemoteDigest(PLEX, 'sha256:new');
            const withRealSocket = new UpdatesService(
                docker.client,
                new DatabaseService(temp.path),
                events,
                updateLog,
                releaseNotesServiceThatNeverFetches(temp.path, updateLog),
                recreate.service,
                temp.path
            );

            await withRealSocket.runScheduledCheck();

            expect(updateLog.log).not.toHaveBeenCalledWith(expect.stringContaining('NOTIFY'));
        });
    });
});
