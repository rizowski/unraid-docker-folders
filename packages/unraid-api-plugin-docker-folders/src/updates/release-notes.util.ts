import type { Row } from '../db/database.service.js';
import { nullableString } from './docker-refs.js';
import type { DockerFoldersReleaseNote } from './updates.model.js';

/** How long a cached row stays valid, per status. Matches `ReleaseNotes` constants. */
export const RELEASE_NOTES_TTL_SECONDS: Readonly<Record<'ok' | 'not_found' | 'error', number>> = {
    ok: 86_400, // 24h
    not_found: 604_800, // 7d — repo has no Releases, don't keep asking
    error: 21_600, // 6h — transient network/5xx
};

export function ttlFor(status: string | null): number {
    if (status === 'not_found') return RELEASE_NOTES_TTL_SECONDS.not_found;
    if (status === 'error') return RELEASE_NOTES_TTL_SECONDS.error;
    return RELEASE_NOTES_TTL_SECONDS.ok;
}

/**
 * Ported from `ReleaseNotes::parseRepo()`. Pure and network-free, unlike
 * `fetchLatest()` — see `release-notes.service.ts`.
 */
export function parseRepo(sourceUrl: string | null): string | null {
    if (sourceUrl === null || sourceUrl === '') return null;

    let url: URL;
    try {
        url = new URL(sourceUrl);
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;

    // Keep the first two segments; ignore /tree/main, /blob/..., etc.
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    if (segments.length < 2) return null;

    const owner = segments[0];
    const name = segments[1].replace(/\.git$/i, '');

    const validSegment = /^[A-Za-z0-9._-]+$/;
    if (!validSegment.test(owner) || !validSegment.test(name)) return null;

    return `${owner}/${name}`.toLowerCase();
}

/** `ReleaseNotes::payload()`: null unless a cached row exists and fetched cleanly. */
export function toReleaseNote(row: Row | undefined): DockerFoldersReleaseNote | null {
    if (row === undefined || String(row.status) !== 'ok') return null;
    return {
        tag: nullableString(row.tag),
        name: nullableString(row.name),
        publishedAt:
            row.published_at === null || row.published_at === undefined ? null : Number(row.published_at),
        url: nullableString(row.url),
        summary: row.summary === null || row.summary === undefined ? '' : String(row.summary),
        fetchedAt: Number(row.fetched_at ?? 0),
    };
}
