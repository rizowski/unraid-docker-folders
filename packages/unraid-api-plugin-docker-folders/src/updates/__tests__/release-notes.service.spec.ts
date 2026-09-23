import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import type { DockerFoldersImageUpdateStatus } from '../updates.model.js';
import { UpdateLogService } from '../update-log.service.js';
import { RELEASE_FETCHER_TOKEN, ReleaseNotesService, toPlainText, type ReleaseFetchResult } from '../release-notes.service.js';

const REPO = 'linuxserver/docker-plex';

function status(overrides: Partial<DockerFoldersImageUpdateStatus> = {}): DockerFoldersImageUpdateStatus {
    return {
        image: 'linuxserver/plex:latest',
        localDigest: null,
        remoteDigest: null,
        updateAvailable: false,
        checkedAt: 0,
        error: null,
        sourceUrl: `https://github.com/${REPO}`,
        sourceRepo: REPO,
        release: null,
        ...overrides,
    };
}

function ok(tag = 'v1.0.0'): ReleaseFetchResult {
    return { status: 'ok', http: 200, release: { tag, name: tag, publishedAt: 100, url: 'https://x', summary: 'notes' } };
}

describe('ReleaseNotesService', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let log: UpdateLogService;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        log = { log: vi.fn() } as unknown as UpdateLogService;
    });

    afterEach(() => {
        temp.cleanup();
    });

    it('never calls the fetcher when no result is pending an update', async () => {
        const fetcher = vi.fn();
        const service = new ReleaseNotesService(db, log, fetcher);
        const results = [status({ updateAvailable: false })];

        await service.refresh(results, true);

        expect(fetcher).not.toHaveBeenCalled();
    });

    it('never calls the fetcher when no result has a sourceRepo', async () => {
        const fetcher = vi.fn();
        const service = new ReleaseNotesService(db, log, fetcher);
        const results = [status({ updateAvailable: true, sourceRepo: null })];

        await service.refresh(results, true);

        expect(fetcher).not.toHaveBeenCalled();
    });

    it('fetches once for a pending repo with no cached row, and attaches the result', async () => {
        const fetcher = vi.fn(async () => ok('v2.0.0'));
        const service = new ReleaseNotesService(db, log, fetcher);
        const results = [status({ updateAvailable: true })];

        // `full: false` (a targeted-check shape): skips the orphan cleanup at
        // the end of refresh(), which reads `image_update_checks` to decide
        // what is still referenced. In real use that table already has this
        // run's rows by the time refresh() runs (UpdatesService.performCheck
        // upserts before calling it); this test never populates it, and
        // `full: true` here would have the cleanup treat the row this test
        // just inserted as orphaned and delete it again.
        await service.refresh(results, false);

        expect(fetcher).toHaveBeenCalledWith(REPO);
        expect(results[0].release).toEqual(
            expect.objectContaining({ tag: 'v2.0.0', name: 'v2.0.0', summary: 'notes', fetchedAt: expect.any(Number) })
        );
        expect(temp.rows('SELECT repo, status FROM release_notes')).toEqual([{ repo: REPO, status: 'ok' }]);
    });

    it('does not re-fetch a row still inside its TTL', async () => {
        const fetcher = vi.fn(async () => ok());
        const service = new ReleaseNotesService(db, log, fetcher);
        db.write((handle) => {
            handle
                .prepare(
                    `INSERT INTO release_notes (repo, status, fetched_at) VALUES (?, 'ok', ?)`
                )
                .run(REPO, Math.floor(Date.now() / 1000));
        });

        await service.refresh([status({ updateAvailable: true })], true);

        expect(fetcher).not.toHaveBeenCalled();
    });

    it('does not re-fetch a not_found row before its longer (7-day) TTL elapses', async () => {
        const fetcher = vi.fn(async () => ok());
        const service = new ReleaseNotesService(db, log, fetcher);
        const almostAWeekAgo = Math.floor(Date.now() / 1000) - 604_800 + 60;
        db.write((handle) => {
            handle
                .prepare(`INSERT INTO release_notes (repo, status, fetched_at) VALUES (?, 'not_found', ?)`)
                .run(REPO, almostAWeekAgo);
        });

        await service.refresh([status({ updateAvailable: true })], true);

        expect(fetcher).not.toHaveBeenCalled();
    });

    it('re-fetches a not_found row once its longer (7-day) TTL has elapsed, unlike a 24h ok row', async () => {
        const fetcher = vi.fn(async () => ok());
        const service = new ReleaseNotesService(db, log, fetcher);
        // Past the 7-day not_found TTL, but still inside a 24h ok TTL — proves
        // ttlFor() is reading this row's own status, not a fixed window.
        const overAWeekAgo = Math.floor(Date.now() / 1000) - 604_800 - 60;
        db.write((handle) => {
            handle
                .prepare(`INSERT INTO release_notes (repo, status, fetched_at) VALUES (?, 'not_found', ?)`)
                .run(REPO, overAWeekAgo);
        });

        await service.refresh([status({ updateAvailable: true })], true);

        expect(fetcher).toHaveBeenCalledWith(REPO);
    });

    it('writes nothing and stops on a rate-limited response, so the cache is never poisoned', async () => {
        const fetcher = vi.fn(async () => ({ status: 'rate_limited', http: 403, release: null }) as ReleaseFetchResult);
        const service = new ReleaseNotesService(db, log, fetcher);

        await service.refresh([status({ updateAvailable: true })], true);

        expect(temp.rows('SELECT * FROM release_notes')).toEqual([]);
    });

    it('writes null into etag unconditionally — PHP never sends or reads one either', async () => {
        const fetcher = vi.fn(async () => ok());
        const service = new ReleaseNotesService(db, log, fetcher);

        // full: false — see the previous test's comment on why.
        await service.refresh([status({ updateAvailable: true })], false);

        expect(temp.rows('SELECT etag FROM release_notes')).toEqual([{ etag: null }]);
    });

    it('drops release notes for repos no image references any more, on a full run only', async () => {
        const fetcher = vi.fn(async () => ok());
        const service = new ReleaseNotesService(db, log, fetcher);
        db.write((handle) => {
            handle.prepare(`INSERT INTO release_notes (repo, status, fetched_at) VALUES ('some/orphan', 'ok', 0)`).run();
            // Stands in for what UpdatesService.performCheck() has already
            // upserted by the time it calls refresh(): this run's own
            // source_repo, so the cleanup query below can tell "still
            // referenced" (REPO) from "orphaned" ('some/orphan') apart.
            handle
                .prepare(
                    `INSERT INTO image_update_checks (image, local_digest, remote_digest, update_available, checked_at, source_repo)
                     VALUES ('linuxserver/plex:latest', NULL, NULL, 0, 0, ?)`
                )
                .run(REPO);
        });

        // Not pending (updateAvailable: false), so this run does not fetch —
        // only the full-cleanup branch is under test here.
        await service.refresh([status({ updateAvailable: false })], true);

        expect(temp.rows('SELECT repo FROM release_notes').map((r) => r.repo)).not.toContain('some/orphan');
    });

    it('keeps orphaned rows on a targeted (non-full) run', async () => {
        const fetcher = vi.fn(async () => ok());
        const service = new ReleaseNotesService(db, log, fetcher);
        db.write((handle) => {
            handle.prepare(`INSERT INTO release_notes (repo, status, fetched_at) VALUES ('some/orphan', 'ok', 0)`).run();
        });

        await service.refresh([status({ updateAvailable: false })], false);

        expect(temp.rows('SELECT repo FROM release_notes').map((r) => r.repo)).toContain('some/orphan');
    });

    it('defaults to the real fetcher when none is injected, so RELEASE_FETCHER_TOKEN is a real DI seam', () => {
        // Constructed with no third argument: must not throw wiring up a
        // default. Not exercised against the network — see the injected-fetcher
        // tests above for behavior coverage.
        expect(() => new ReleaseNotesService(db, log)).not.toThrow();
        expect(RELEASE_FETCHER_TOKEN).toBe('DOCKER_FOLDERS_RELEASE_FETCHER');
    });
});

describe('toPlainText', () => {
    it('strips a fenced code block', () => {
        expect(toPlainText('before\n```js\ncode\n```\nafter')).toBe('before after');
    });

    it('turns a markdown link into its text', () => {
        expect(toPlainText('See [the docs](https://example.com) for more.')).toBe('See the docs for more.');
    });

    it('drops an image reference entirely', () => {
        expect(toPlainText('Look: ![alt](https://example.com/x.png) done')).toBe('Look: done');
    });

    it('strips heading and bullet markers', () => {
        expect(toPlainText('# Title\n- one\n- two')).toBe('Title one two');
    });

    it('strips emphasis markers without eating snake_case identifiers', () => {
        expect(toPlainText('This is *bold* and this is `code` and a_snake_case_name stays.')).toBe(
            'This is bold and this is code and a_snake_case_name stays.'
        );
    });

    it('truncates to 400 characters with an ellipsis', () => {
        const long = 'a'.repeat(500);
        const result = toPlainText(long);
        expect(result.length).toBe(401);
        expect(result.endsWith('…')).toBe(true);
    });

    it('returns empty string for empty input', () => {
        expect(toPlainText('')).toBe('');
    });
});
