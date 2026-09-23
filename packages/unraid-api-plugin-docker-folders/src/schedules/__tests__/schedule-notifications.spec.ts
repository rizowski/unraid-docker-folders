import { describe, expect, it, vi } from 'vitest';

import {
    buildScheduleFailureNotification,
    buildScheduleSkipNotification,
    formatRunLateness,
    sendUnraidNotification,
} from '../schedule-notifications.js';

/**
 * Every case here is ported from `tests/php/ScheduleManagerTest.php`'s
 * notification and lateness tests, which assert on `config.php`'s
 * `formatRunLateness`, `buildScheduleFailureNotification`, and
 * `buildScheduleSkipNotification`. The text is asserted verbatim, punctuation
 * included, because it is what a user reads in Unraid's notification panel.
 */

vi.mock('node:child_process', () => ({
    execFile: vi.fn((_cmd: string, _args: string[], callback: () => void) => {
        callback();
    }),
}));

describe('formatRunLateness', () => {
    it('reads in hours and minutes', () => {
        expect(formatRunLateness(6 * 3600 + 40 * 60)).toBe('6h 40m');
        expect(formatRunLateness(20 * 60)).toBe('20m');
        expect(formatRunLateness(45)).toBe('45s');
        expect(formatRunLateness(-10)).toBe('0s');
    });

    it('drops the minutes when there are none', () => {
        expect(formatRunLateness(3600)).toBe('1h 0m');
    });

    it('drops the seconds entirely once a whole minute has passed', () => {
        expect(formatRunLateness(60)).toBe('1m');
    });

    it('truncates rather than rounds', () => {
        expect(formatRunLateness(119.9)).toBe('1m');
        expect(formatRunLateness(3599.9)).toBe('59m');
    });
});

describe('buildScheduleFailureNotification', () => {
    it('names the schedule and container', () => {
        const n = buildScheduleFailureNotification(
            { name: 'Nightly restart', target_type: 'container', target_id: 'plex', action: 'restart' },
            "Container 'plex' not found"
        );

        expect(n.subject).toBe('Schedule failed: Nightly restart');
        expect(n.description).toBe("Could not restart container plex: Container 'plex' not found");
    });

    it('names a stack', () => {
        const n = buildScheduleFailureNotification(
            { name: 'Stop media', target_type: 'stack', target_id: 'media', action: 'stop' },
            'compose down failed'
        );

        expect(n.description).toBe('Could not stop stack media: compose down failed');
    });

    it('describes a backup differently, with no target named', () => {
        const n = buildScheduleFailureNotification(
            { name: 'Weekly backup', target_type: 'container', target_id: 'plex', action: 'backup' },
            'Invalid backup configuration'
        );

        expect(n.description).toBe('Backup failed: Invalid backup configuration');
    });

    it('falls back to "unnamed schedule" and "Unknown error" when both are blank', () => {
        const n = buildScheduleFailureNotification(
            { name: '', target_type: 'container', target_id: 'plex', action: 'start' },
            ''
        );

        expect(n.subject).toBe('Schedule failed: unnamed schedule');
        expect(n.description).toBe('Could not start container plex: Unknown error');
    });

    it('trims whitespace-only name and message the same way as blank ones', () => {
        const n = buildScheduleFailureNotification(
            { name: '   ', target_type: 'container', target_id: 'plex', action: 'start' },
            '   '
        );

        expect(n.subject).toBe('Schedule failed: unnamed schedule');
        expect(n.description).toBe('Could not start container plex: Unknown error');
    });
});

describe('buildScheduleSkipNotification', () => {
    it('names the schedule and the delay', () => {
        const n = buildScheduleSkipNotification(
            { name: 'Nightly restart', target_type: 'container', target_id: 'plex', action: 'restart' },
            6 * 3600 + 40 * 60
        );

        expect(n.subject).toBe('Schedule skipped: Nightly restart');
        expect(n.description).toContain('Did not restart container plex');
        expect(n.description).toContain('6h 40m past its scheduled time');
        expect(n.description).toContain('The schedule runner was not active when it came due.');
    });

    it('falls back to "unnamed schedule" when the name is blank', () => {
        const n = buildScheduleSkipNotification(
            { name: '', target_type: 'stack', target_id: 'media', action: 'stop' },
            90
        );

        expect(n.subject).toBe('Schedule skipped: unnamed schedule');
        expect(n.description).toBe(
            'Did not stop stack media: the run was 1m past its scheduled time.' +
                ' The schedule runner was not active when it came due.'
        );
    });
});

describe('sendUnraidNotification', () => {
    it('posts through the notify script with the expected arguments', async () => {
        const { execFile } = await import('node:child_process');

        sendUnraidNotification({ subject: 'Schedule failed: x', description: 'boom' }, 'warning');

        expect(execFile).toHaveBeenCalledWith(
            '/usr/local/emhttp/webGui/scripts/notify',
            [
                '-e',
                'Docker Folders',
                '-s',
                'Schedule failed: x',
                '-d',
                'boom',
                '-i',
                'warning',
                '-l',
                '/Docker/Folders',
            ],
            expect.any(Function)
        );
    });

    it('defaults to normal importance', async () => {
        const { execFile } = await import('node:child_process');
        vi.mocked(execFile).mockClear();

        sendUnraidNotification({ subject: 'Schedule skipped: x', description: 'late' });

        expect(execFile).toHaveBeenCalledWith(
            expect.any(String),
            expect.arrayContaining(['-i', 'normal']),
            expect.any(Function)
        );
    });
});
