import { readFileSync, readlinkSync } from 'node:fs';

/**
 * Which timezone Unraid itself is configured for, ported from
 * `detectServerTimezone()` in `include/config.php`.
 *
 * Both backends read the same schedule-entry times and log timestamps in
 * server-local time, so they have to agree on what "server-local" means.
 * PHP does not ask the OS or a library for "the current zone" — it reads the
 * two files Unraid itself writes when the user sets a timezone in the GUI,
 * in the same order PHP does:
 *   1. `timeZone="..."` in `/boot/config/ident.cfg`.
 *   2. The `/etc/localtime` symlink target, which Unraid also maintains,
 *      read as the path segment after `zoneinfo/`.
 *   3. UTC, if neither yields something recognizable.
 *
 * Deliberately not `Intl.DateTimeFormat().resolvedOptions().timeZone`. That
 * answers "what zone is this process/container configured with" via TZ env
 * or the system default, which is a different question and can disagree with
 * what Unraid's GUI has stored — exactly the gap that would make a schedule
 * fire at a different local time depending on which backend evaluated it.
 * `Intl` is used below only to validate that a candidate string is a real
 * IANA identifier (Node has no equivalent of PHP's
 * `DateTimeZone::listIdentifiers()` to check against), never to source the
 * zone itself.
 */
export function detectServerTimezone(
    identCfg = '/boot/config/ident.cfg',
    localtime = '/etc/localtime'
): string {
    // Memoized per path pair, matching the PHP static cache: config.php loads
    // on every request, including the stats poll, and the answer cannot change
    // within one process.
    const cacheKey = `${identCfg}|${localtime}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const candidates: string[] = [];

    const fromIdentCfg = readTimeZoneFromIdentCfg(identCfg);
    if (fromIdentCfg !== null) candidates.push(fromIdentCfg);

    const fromLocaltime = readTimeZoneFromLocaltimeLink(localtime);
    if (fromLocaltime !== null) candidates.push(fromLocaltime);

    let zone = 'UTC';
    for (const candidate of candidates) {
        if (isValidTimeZone(candidate)) {
            zone = candidate;
            break;
        }
    }

    cache.set(cacheKey, zone);
    return zone;
}

const cache = new Map<string, string>();

/** Reads `timeZone="America/Denver"` out of ident.cfg's flat INI format. */
function readTimeZoneFromIdentCfg(path: string): string | null {
    let content: string;
    try {
        content = readFileSync(path, 'utf8');
    } catch {
        return null;
    }

    // ident.cfg is not full INI (no sections), just KEY="value" lines, so a
    // targeted line match stands in for parse_ini_file() here.
    const quoted = content.match(/^\s*timeZone\s*=\s*"([^"]*)"\s*$/m);
    const bare = content.match(/^\s*timeZone\s*=\s*([^\r\n"]+)\s*$/m);
    const value = (quoted?.[1] ?? bare?.[1])?.trim();
    return value ? value : null;
}

/** Reads the zone name out of the `/etc/localtime` symlink target. */
function readTimeZoneFromLocaltimeLink(path: string): string | null {
    let target: string;
    try {
        // readlinkSync throws for a missing path or a non-symlink, the same
        // cases PHP's readlink() answers `false` for.
        target = readlinkSync(path);
    } catch {
        return null;
    }

    const match = target.match(/zoneinfo\/(.+)$/);
    return match ? match[1] : null;
}

function isValidTimeZone(zone: string): boolean {
    try {
        // Throws RangeError for anything that is not a recognized IANA zone.
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}
