import { execFile } from 'node:child_process';

/**
 * The Unraid notifications the runner sends, ported from `config.php`.
 *
 * The text is ported exactly, including punctuation, because it is what a user
 * sees in Unraid's notification panel and the PHP tests assert on it.
 */

export interface ScheduleAbout {
    name?: string | null;
    target_type?: string | null;
    target_id?: string | null;
    action?: string | null;
}

export interface NotificationText {
    subject: string;
    description: string;
}

/** A lateness in whole minutes and hours, such as "6h 40m". */
export function formatRunLateness(seconds: number): string {
    const total = Math.max(0, Math.trunc(seconds));
    const minutesTotal = Math.trunc(total / 60);
    const hours = Math.trunc(minutesTotal / 60);
    const minutes = minutesTotal % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${total}s`;
}

export function buildScheduleFailureNotification(
    schedule: ScheduleAbout,
    message: string
): NotificationText {
    const name = (schedule.name ?? '').trim();
    const reason = message.trim() === '' ? 'Unknown error' : message.trim();
    const action = schedule.action ?? '';

    let description: string;
    if (action === 'backup') {
        description = `Backup failed: ${reason}`;
    } else {
        const kind = schedule.target_type === 'stack' ? 'stack' : 'container';
        description = `Could not ${action} ${kind} ${schedule.target_id ?? ''}: ${reason}`;
    }

    return {
        subject: `Schedule failed: ${name !== '' ? name : 'unnamed schedule'}`,
        description,
    };
}

export function buildScheduleSkipNotification(
    schedule: ScheduleAbout,
    lateBySeconds: number
): NotificationText {
    const name = (schedule.name ?? '').trim();
    const kind = schedule.target_type === 'stack' ? 'stack' : 'container';

    return {
        subject: `Schedule skipped: ${name !== '' ? name : 'unnamed schedule'}`,
        description:
            `Did not ${schedule.action ?? ''} ${kind} ${schedule.target_id ?? ''}: ` +
            `the run was ${formatRunLateness(lateBySeconds)} past its scheduled time.` +
            ' The schedule runner was not active when it came due.',
    };
}

const NOTIFY_SCRIPT = '/usr/local/emhttp/webGui/scripts/notify';

/**
 * Post through Unraid's own notify script.
 *
 * An argument array rather than the PHP's escapeshellarg-built string: the
 * subject and description carry a schedule name and an error message, both of
 * which a user or a failing command controls, and with no shell in between
 * there is nothing for them to break out of. Fire and forget, like the PHP; a
 * notification that fails must not fail the run it reports on.
 */
export function sendUnraidNotification(
    text: NotificationText,
    importance: 'normal' | 'warning' | 'alert' = 'normal'
): void {
    execFile(
        NOTIFY_SCRIPT,
        ['-e', 'Docker Folders', '-s', text.subject, '-d', text.description, '-i', importance, '-l', '/Docker/Folders'],
        () => {}
    );
}
