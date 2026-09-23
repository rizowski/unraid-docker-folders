import { Inject, Injectable, Optional } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';

import { DatabaseService, type Row } from '../db/database.service.js';
import { nowSeconds } from '../util/time.js';
import { UpdateLogService } from './update-log.service.js';
import { toReleaseNote, ttlFor } from './release-notes.util.js';
import type { DockerFoldersImageUpdateStatus } from './updates.model.js';

/** GitHub REST API root. */
const API_BASE = 'https://api.github.com';

/** GitHub 403s any request that arrives without a User-Agent. */
const USER_AGENT = 'unraid-docker-folders-modern';

/**
 * PHP splits this into a 3s connect timeout and a 5s total timeout
 * (`ReleaseNotes::CONNECT_TIMEOUT`/`TIMEOUT`). `fetch`'s `AbortSignal.timeout`
 * only expresses one overall deadline, so this uses the 5s total and accepts
 * that a slow DNS/connect phase eats into it rather than failing separately
 * and faster, as curl's split would.
 */
const FETCH_TIMEOUT_MS = 5_000;

/** Release bodies can be enormous; the modal row shows one line. */
const SUMMARY_MAX_CHARS = 400;

/** Unauthenticated GitHub allows 60 requests/hour/IP; cron runs at most hourly. */
const MAX_FETCHES_PER_RUN = 20;

/** Total wall-clock budget for a run's fetches, so 20 timeouts can't add 100s. */
const MAX_WALL_SECONDS = 30;

export type ReleaseFetchStatus = 'ok' | 'not_found' | 'error' | 'rate_limited';

export interface ReleaseFetchResult {
    status: ReleaseFetchStatus;
    http: number;
    release: {
        tag: string | null;
        name: string | null;
        publishedAt: number | null;
        url: string | null;
        summary: string;
    } | null;
}

export type ReleaseFetcher = (repo: string) => Promise<ReleaseFetchResult>;

/** Overrides the GitHub fetch. Only the tests supply one — see the class doc. */
export const RELEASE_FETCHER_TOKEN = 'DOCKER_FOLDERS_RELEASE_FETCHER';

/**
 * Flatten release markdown to a single line of plain text, ported from
 * `ReleaseNotes::toPlainText()`. Runs at write time so the raw body is never
 * persisted — see that method's doc for why (the summary reaches the parent
 * Unraid document via postMessage in PHP mode; treat it the same way here).
 */
export function toPlainText(markdown: string): string {
    if (markdown === '') return '';

    let text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/```[\s\S]*?```/g, ' ');
    text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    text = text.replace(/<[^>]*>/g, ''); // strip_tags()
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // links -> text
    // PHP runs this same rule in this same position, after strip_tags() has
    // already removed every `<...>` span — so it can only ever match text
    // this port's strip_tags() step has already destroyed too. Ported as-is
    // (same ordering, likely the same dead code) rather than "fixed" here.
    text = text.replace(/<(https?:\/\/[^>]+)>/g, '$1'); // autolinks
    // Line-leading markers: headings, quotes, bullets, ordered list numbers.
    text = text.replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '');
    text = text.replace(/\*\*|__|`/g, '');
    // Single-character emphasis, opening and closing. Anchored so snake_case
    // identifiers and a bare "*" in prose survive.
    text = text.replace(/(?<!\w)[*_](?=\S)/g, '');
    text = text.replace(/(?<=\S)[*_](?!\w)/g, '');
    text = text.replace(/\s+/g, ' ').trim();

    return truncate(text, SUMMARY_MAX_CHARS);
}

function truncate(text: string, cap: number): string {
    if (cap <= 0) return '';
    if (text.length <= cap) return text;
    return `${text.slice(0, cap).replace(/\s+$/, '')}…`;
}

async function defaultFetcher(repo: string): Promise<ReleaseFetchResult> {
    let response: Response;
    try {
        response = await fetch(`${API_BASE}/repos/${repo}/releases/latest`, {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': USER_AGENT,
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
    } catch {
        return { status: 'error', http: 0, release: null };
    }

    if (response.status === 404) {
        return { status: 'not_found', http: 404, release: null };
    }

    // 403/429 with the budget exhausted means back off entirely; the caller
    // aborts the run rather than writing rows that would poison the cache.
    const rateRemaining = response.headers.get('x-ratelimit-remaining');
    if (response.status === 429 || (response.status === 403 && rateRemaining === '0')) {
        return { status: 'rate_limited', http: response.status, release: null };
    }

    if (response.status >= 400) {
        return { status: 'error', http: response.status, release: null };
    }

    let data: unknown;
    try {
        data = await response.json();
    } catch {
        return { status: 'error', http: response.status, release: null };
    }
    if (typeof data !== 'object' || data === null) {
        return { status: 'error', http: response.status, release: null };
    }

    const obj = data as Record<string, unknown>;
    let publishedAt: number | null = null;
    if (typeof obj.published_at === 'string') {
        const ts = Date.parse(obj.published_at);
        publishedAt = Number.isNaN(ts) ? null : Math.floor(ts / 1000);
    }

    return {
        status: 'ok',
        http: response.status,
        release: {
            tag: typeof obj.tag_name === 'string' ? obj.tag_name : null,
            name: typeof obj.name === 'string' ? obj.name : null,
            publishedAt,
            url: typeof obj.html_url === 'string' ? obj.html_url : null,
            summary: toPlainText(typeof obj.body === 'string' ? obj.body : ''),
        },
    };
}

function readReleaseNotesFor(db: DatabaseSync, repos: string[]): Map<string, Row> {
    if (repos.length === 0) return new Map();
    const placeholders = repos.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM release_notes WHERE repo IN (${placeholders})`).all(...repos) as Row[];
    return new Map(rows.map((row): [string, Row] => [String(row.repo), row]));
}

/**
 * `ReleaseNotes::fetchLatest()` plus `refreshReleaseNotes()` from
 * `config.php`: the GitHub call and the stale/budget/decorate bookkeeping
 * around it.
 *
 * Deliberately NOT part of `UpdatesService`'s Docker calls: PHP keeps
 * `ReleaseNotes` out of `DockerClient` on purpose, because it is the one part
 * of the plugin (besides the Compose binary download) that reaches the public
 * internet rather than the local Docker socket, and that boundary is worth
 * keeping visible here too.
 *
 * The etag column exists in the schema (`release_notes.etag`) and this writes
 * `null` into it on every row, same as PHP. That is not an omission: PHP's
 * `fetchLatest()` never reads or sends an ETag either — no `If-None-Match`
 * request header, no response header read, the column is simply unused. There
 * is no conditional-request behavior to port.
 */
@Injectable()
export class ReleaseNotesService {
    constructor(
        private readonly db: DatabaseService,
        private readonly log: UpdateLogService,
        @Optional() @Inject(RELEASE_FETCHER_TOKEN) private readonly fetcher: ReleaseFetcher = defaultFetcher
    ) {}

    /**
     * Refreshes stale, pending repos and attaches `release` to every result in
     * place — mutating each element's `.release`, mirroring PHP's `&$results`.
     * `full` gates the orphaned-repo cleanup, exactly like the stale
     * `image_update_checks` cleanup: a targeted check's `results` only holds
     * the requested subset, and an unconditional cleanup would read that as
     * "every other repo is orphaned".
     */
    async refresh(results: DockerFoldersImageUpdateStatus[], full: boolean): Promise<void> {
        const now = nowSeconds();

        // repo => whether any image on that repo actually has an update pending
        const candidates = new Map<string, boolean>();
        for (const info of results) {
            const repo = info.sourceRepo;
            if (repo === null || repo === '') continue;
            candidates.set(repo, (candidates.get(repo) ?? false) || info.updateAvailable);
        }
        if (candidates.size === 0) return;

        const repos = [...candidates.keys()];
        const rows = this.db.read((db) => readReleaseNotesFor(db, repos));

        // Stale = pending an update, and either never fetched or past its TTL.
        const stale: { repo: string; fetchedAt: number }[] = [];
        for (const [repo, pending] of candidates) {
            if (!pending) continue;
            const row = rows.get(repo);
            if (row === undefined) {
                stale.push({ repo, fetchedAt: 0 });
                continue;
            }
            const fetchedAt = Number(row.fetched_at ?? 0);
            if (now - fetchedAt >= ttlFor(row.status === null || row.status === undefined ? null : String(row.status))) {
                stale.push({ repo, fetchedAt });
            }
        }

        // Oldest first. Without the ordering the same repos win the cap every
        // run and anything past the cap would never get notes at all.
        stale.sort((a, b) => a.fetchedAt - b.fetchedAt);
        const toFetch = stale.slice(0, MAX_FETCHES_PER_RUN).map((s) => s.repo);
        if (stale.length > toFetch.length) {
            this.log.log(`NOTES CAP ${toFetch.length} of ${stale.length} stale repo(s) this run`);
        }

        const startedAt = Date.now();
        for (const repo of toFetch) {
            if ((Date.now() - startedAt) / 1000 >= MAX_WALL_SECONDS) {
                this.log.log('NOTES BUDGET Wall-clock budget reached, deferring remaining repo(s)');
                break;
            }

            const result = await this.fetcher(repo);

            // Deliberately write nothing on a rate-limit: caching an empty row
            // would suppress notes for this repo for hours over a transient 403.
            if (result.status === 'rate_limited') {
                this.log.log('NOTES RATE-LIMIT GitHub budget exhausted, skipping remaining repo(s)');
                break;
            }

            const release = result.status === 'ok' ? result.release : null;
            const status: 'ok' | 'not_found' | 'error' =
                result.status === 'ok' || result.status === 'not_found' ? result.status : 'error';

            const row: Row = {
                repo,
                tag: release?.tag ?? null,
                name: release?.name ?? null,
                published_at: release?.publishedAt ?? null,
                url: release?.url ?? null,
                summary: release?.summary ?? null,
                etag: null,
                status,
                fetched_at: now,
            };

            this.db.write((db) => {
                db.prepare(
                    `INSERT OR REPLACE INTO release_notes (repo, tag, name, published_at, url, summary, etag, status, fetched_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    String(row.repo),
                    row.tag as string | null,
                    row.name as string | null,
                    row.published_at as number | null,
                    row.url as string | null,
                    row.summary as string | null,
                    row.etag as string | null,
                    row.status as string,
                    row.fetched_at as number
                );
            });
            rows.set(repo, row);

            if (status === 'ok') {
                this.log.log(`NOTES OK ${repo} ${release?.tag ?? '(untagged)'}`);
            } else if (status === 'not_found') {
                this.log.log(`NOTES 404 ${repo}: no releases published`);
            } else {
                this.log.log(`NOTES ERROR ${repo}: HTTP ${result.http ?? 0}`);
            }
        }

        // Decorate every result from `rows`, which the fetch loop kept current.
        for (const info of results) {
            info.release = info.sourceRepo !== null ? toReleaseNote(rows.get(info.sourceRepo)) : null;
        }

        // Drop notes for repos no container references any more. Skipped on a
        // targeted check, where `results` only holds the requested subset.
        if (full) {
            this.db.write((db) => {
                db.prepare(
                    `DELETE FROM release_notes
                      WHERE repo NOT IN (SELECT source_repo FROM image_update_checks WHERE source_repo IS NOT NULL)`
                ).run();
            });
        }
    }
}
