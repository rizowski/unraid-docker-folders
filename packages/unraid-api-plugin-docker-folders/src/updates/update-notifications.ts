import type { NotificationText } from '../schedules/schedule-notifications.js';

/** Names capped so a big server does not produce a wall of text in the notification. */
const MAX_NOTIFICATION_NAMES = 10;

/**
 * Compose the Unraid notification for newly available updates, ported from
 * `buildUpdateNotification()` in `config.php`.
 *
 * Counts containers rather than images (one image can back several
 * containers) and names them, capped. `newImages` is the set of images that
 * flipped to update-available *since the last check* — computed by the
 * caller (`UpdatesService.runScheduledCheck`) by snapshotting
 * `image_update_checks.update_available` before checking, exactly like
 * `check-updates.php` does; this function itself does not know what counts
 * as "new".
 */
export function buildUpdateNotification(
    newImages: string[],
    containersByImage: Map<string, string[]>
): NotificationText | null {
    const names = new Set<string>();
    for (const image of newImages) {
        for (const name of containersByImage.get(image) ?? []) names.add(name);
    }
    if (names.size === 0) return null;

    // Approximates PHP's `sort($names, SORT_NATURAL | SORT_FLAG_CASE)`: natural,
    // case-insensitive ordering. `localeCompare`'s `numeric`/`base` options are
    // the closest built-in equivalent; they can disagree with PHP's natural
    // sort on unusual punctuation, which no known container name exercises.
    const sorted = [...names].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );

    const count = sorted.length;
    const subject = `${count} container update${count === 1 ? '' : 's'} available`;

    const shown = sorted.slice(0, MAX_NOTIFICATION_NAMES);
    let description = shown.join(', ');
    const rest = count - shown.length;
    if (rest > 0) description += ` and ${rest} more`;

    return { subject, description };
}
