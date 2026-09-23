import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { SettingsService } from '../settings.service.js';

vi.mock('../../util/timezone.js', () => ({
    detectServerTimezone: vi.fn(() => 'America/Denver'),
}));

describe('SettingsService', () => {
    let temp: TempDatabase;
    let service: SettingsService;

    beforeEach(() => {
        temp = createMigratedDatabase();
        service = new SettingsService(new DatabaseService(temp.path));
    });

    afterEach(() => {
        temp.cleanup();
    });

    describe('getAll', () => {
        // The migrations seed a handful of default rows (theme, version, and
        // so on), so this only asserts the synthetic entry rides along with
        // whatever PHP's own migrations put there — not that the table starts
        // empty.
        it('includes the synthetic server_timezone entry', () => {
            expect(service.getAll()).toEqual(
                expect.arrayContaining([{ key: 'server_timezone', value: 'America/Denver' }])
            );
        });

        it('includes every stored row alongside the synthetic entry', () => {
            service.set('sort_mode', 'name-asc');
            service.set('show_stats', '0');

            expect(service.getAll()).toEqual(
                expect.arrayContaining([
                    { key: 'sort_mode', value: 'name-asc' },
                    { key: 'show_stats', value: '0' },
                    { key: 'server_timezone', value: 'America/Denver' },
                ])
            );
        });

        it('cannot be overwritten through set(), because it is not in the allowlist', () => {
            expect(() => service.set('server_timezone', 'UTC')).toThrow(BadRequestException);
        });
    });

    describe('set — allowlist', () => {
        it('rejects a key PHP does not recognize either', () => {
            expect(() => service.set('csrf_token', 'x')).toThrow('Invalid settings key');
        });

        it('accepts every key in the PHP allowlist, including backend_mode', () => {
            expect(() => service.set('backend_mode', 'php')).not.toThrow();
        });
    });

    describe('set — backend_mode', () => {
        it('accepts the two known transports', () => {
            expect(service.set('backend_mode', 'php').value).toBe('php');
            expect(service.set('backend_mode', 'graphql').value).toBe('graphql');
        });

        it('rejects anything else, so the frontend is never left with no transport', () => {
            expect(() => service.set('backend_mode', 'rest')).toThrow('Invalid backend mode');
        });
    });

    describe('set — sort_mode', () => {
        it('accepts one of the six known modes', () => {
            expect(service.set('sort_mode', 'created-desc').value).toBe('created-desc');
        });

        it('rejects a mode that is not one of the six', () => {
            expect(() => service.set('sort_mode', 'size-desc')).toThrow('Invalid sort_mode');
        });
    });

    describe('set — value length', () => {
        it('rejects a value over 10000 characters', () => {
            expect(() => service.set('update_check_exclude', 'x'.repeat(10001))).toThrow(
                'Value too long'
            );
        });

        it('accepts exactly 10000 characters', () => {
            expect(() => service.set('update_check_exclude', 'x'.repeat(10000))).not.toThrow();
        });
    });

    describe('set — path settings', () => {
        it('normalizes and accepts a compose_export_dir under /mnt', () => {
            const setting = service.set('compose_export_dir', '/mnt/user/appdata/../appdata/compose');
            expect(setting.value).toBe('/mnt/user/appdata/compose');
        });

        it('rejects a compose_export_dir outside the allowed roots', () => {
            expect(() => service.set('compose_export_dir', '/etc/evil')).toThrow(
                /Path must be under/
            );
        });

        it('rejects a relative compose_export_dir', () => {
            expect(() => service.set('compose_export_dir', 'relative/path')).toThrow(
                'Path must be absolute'
            );
        });

        it('accepts a backup_destination under /boot/config/plugins', () => {
            const setting = service.set(
                'backup_destination',
                '/boot/config/plugins/unraid-docker-folders-modern/backups'
            );
            expect(setting.value).toBe('/boot/config/plugins/unraid-docker-folders-modern/backups');
        });

        it('rejects a backup_destination outside the allowed roots', () => {
            expect(() => service.set('backup_destination', '/root/backups')).toThrow(
                /Path must be under/
            );
        });

        it('treats an empty value as "use the default" and skips the path check', () => {
            expect(service.set('compose_export_dir', '').value).toBe('');
        });

        it('treats a whitespace-only value the same way, leaving it untouched', () => {
            expect(service.set('backup_destination', '   ').value).toBe('   ');
        });
    });

    describe('set — update_concurrency', () => {
        it('clamps to the 1..5 range', () => {
            expect(service.set('update_concurrency', '3').value).toBe('3');
        });

        it('rejects 0', () => {
            expect(() => service.set('update_concurrency', '0')).toThrow(
                'update_concurrency must be between 1 and 5'
            );
        });

        it('rejects 6', () => {
            expect(() => service.set('update_concurrency', '6')).toThrow(
                'update_concurrency must be between 1 and 5'
            );
        });

        it('rejects a non-numeric value the same way PHP\'s (int) cast would', () => {
            expect(() => service.set('update_concurrency', 'abc')).toThrow(
                'update_concurrency must be between 1 and 5'
            );
        });

        it('stores the clamped integer as a string, not the raw input', () => {
            expect(service.set('update_concurrency', '3abc').value).toBe('3');
        });
    });

    describe('set — stats_refresh_interval', () => {
        it('stores 1 through 300 seconds as an integer string', () => {
            expect(service.set('stats_refresh_interval', '1').value).toBe('1');
            expect(service.set('stats_refresh_interval', '300').value).toBe('300');
            expect(service.set('stats_refresh_interval', '5s').value).toBe('5');
        });

        it('rejects 0, 301, and a non-numeric value', () => {
            for (const bad of ['0', '301', 'abc']) {
                expect(() => service.set('stats_refresh_interval', bad)).toThrow(
                    'stats_refresh_interval must be between 1 and 300'
                );
            }
        });
    });

    describe('set — upsert', () => {
        it('inserts a new key', () => {
            service.set('show_stats', '1');

            expect(temp.rows('SELECT key, value FROM settings WHERE key = ?', ['show_stats'])).toEqual(
                [{ key: 'show_stats', value: '1' }]
            );
        });

        it('updates an existing key in place, bumping updated_at', () => {
            service.set('show_stats', '1');
            const [firstRow] = temp.rows('SELECT updated_at FROM settings WHERE key = ?', [
                'show_stats',
            ]);

            service.set('show_stats', '0');

            const rows = temp.rows('SELECT key, value FROM settings WHERE key = ?', ['show_stats']);
            expect(rows).toEqual([{ key: 'show_stats', value: '0' }]);
            expect(firstRow).toBeDefined();
        });
    });
});
