import { BadRequestException, Injectable } from '@nestjs/common';

import { DatabaseService, type Row } from '../db/database.service.js';
import { SORT_MODES } from '../folders/folder.model.js';
import { normalizePath, pathIsWithinAny } from '../paths/paths.js';
import { detectServerTimezone } from '../util/timezone.js';
import { nowSeconds } from '../util/time.js';
import { BACKEND_MODES, DockerFoldersSetting, isAllowedSettingKey } from './settings.model.js';

/**
 * `settings.value` is a schemaless TEXT column, and `settings.php` caps a
 * string write at this many characters before it ever reaches SQLite.
 */
const MAX_VALUE_LENGTH = 10000;

/**
 * Roots a path-shaped setting is allowed to point into, ported from
 * `EXPORT_ALLOWED_ROOTS` / `BACKUP_ALLOWED_ROOTS` in `include/config.php`.
 * `CONFIG_DIR` there is `/boot/config/plugins/unraid-docker-folders-modern`,
 * the same literal `database.service.ts`'s `DEFAULT_DB_PATH` is built from.
 */
const CONFIG_DIR = '/boot/config/plugins/unraid-docker-folders-modern';
const EXPORT_ALLOWED_ROOTS = ['/mnt', CONFIG_DIR] as const;
const BACKUP_ALLOWED_ROOTS = ['/mnt', '/boot/config/plugins'] as const;

/**
 * Which keys are path-shaped, and what they are allowed to resolve under.
 * These are the top of a chain that ends in mkdir/write as root:
 * `compose_export_dir` reaches `ComposeManager::exportConfigs` and
 * `backup_destination` reaches `BackupManager::resolveDestination`, both
 * still PHP-only. This plugin does not walk that chain yet, but the value it
 * stores is shared with PHP, so it must pass the same containment check PHP
 * would apply before writing it, not a looser one.
 */
const PATH_SETTING_ROOTS: Readonly<Record<string, readonly string[]>> = {
    compose_export_dir: EXPORT_ALLOWED_ROOTS,
    backup_destination: BACKUP_ALLOWED_ROOTS,
};

/**
 * The settings read and write path, ported from `api/settings.php`.
 *
 * Unlike `FolderService`, a write here never calls `EventBusService.publish`.
 * That is not an omission: `settings.php`'s `handlePost()` has no
 * `WebSocketPublisher` call either, so a settings change is picked up by the
 * frontend's normal 30-second poll rather than a live push in either backend.
 * Adding a publish here would make GraphQL mode announce something PHP mode
 * never does, which is the kind of mode-dependent behavior this port is
 * supposed to avoid.
 */
@Injectable()
export class SettingsService {
    constructor(private readonly db: DatabaseService) {}

    /**
     * Every stored setting, plus the synthetic `server_timezone` entry.
     *
     * `server_timezone` is read-only and not in `ALLOWED_SETTING_KEYS`, so
     * `set()` can never be used to overwrite it — matching `handleGet()`,
     * which computes it fresh from `date_default_timezone_get()` instead of
     * reading it out of the table.
     */
    getAll(): DockerFoldersSetting[] {
        const rows = this.db.read(
            (db) => db.prepare('SELECT key, value FROM settings').all() as Row[]
        );

        const settings = rows.map(
            (row): DockerFoldersSetting => ({
                key: String(row.key),
                value: row.value === null || row.value === undefined ? null : String(row.value),
            })
        );

        settings.push({ key: 'server_timezone', value: detectServerTimezone() });

        return settings;
    }

    /**
     * Validate and upsert one setting, in the same order `handlePost()` does:
     * allowlist, then the two fixed-vocabulary keys, then length, then path
     * containment, then the `update_concurrency` clamp. Order matters only in
     * that an earlier check must not let a later one see a value it would
     * mishandle (e.g. the length cap runs before a path is normalized, so a
     * 10001-character path is rejected for its length, not resolved first).
     */
    set(key: string, value: string): DockerFoldersSetting {
        if (!isAllowedSettingKey(key)) {
            throw new BadRequestException('Invalid settings key');
        }

        // Anything other than the two known transports would leave the
        // frontend with no backend to talk to, so reject rather than store it.
        if (key === 'backend_mode' && !(BACKEND_MODES as readonly string[]).includes(value)) {
            throw new BadRequestException('Invalid backend mode');
        }

        if (key === 'sort_mode' && !(SORT_MODES as readonly string[]).includes(value)) {
            throw new BadRequestException('Invalid sort_mode');
        }

        if (value.length > MAX_VALUE_LENGTH) {
            throw new BadRequestException('Value too long');
        }

        // An empty (or whitespace-only) value means "use the default" and
        // skips the path check entirely — PHP leaves the value untouched (not
        // even trimmed) in that case, so this does too.
        let stored = value;
        const roots = PATH_SETTING_ROOTS[key];
        if (roots && value.trim() !== '') {
            const normalized = normalizePath(value.trim());
            if (normalized === null) {
                throw new BadRequestException('Path must be absolute');
            }
            if (!pathIsWithinAny(normalized, roots)) {
                throw new BadRequestException(`Path must be under ${roots.join(' or ')}`);
            }
            stored = normalized;
        }

        // Clamp bounded numeric settings — the UI <select> is not the only
        // writer. `Number.parseInt` returning NaN for a non-numeric string
        // maps to 0 here, the same value PHP's `(int)` cast produces, so a
        // garbage input fails the range check exactly like it does in PHP
        // rather than silently passing through as NaN.
        if (key === 'update_concurrency') {
            const parsed = Number.parseInt(stored, 10);
            const n = Number.isNaN(parsed) ? 0 : parsed;
            if (n < 1 || n > 5) {
                throw new BadRequestException('update_concurrency must be between 1 and 5');
            }
            stored = String(n);
        }

        // TODO(scheduler): `settings.php` also has two cron side effects here
        // that this port intentionally leaves out:
        //   - writing `update_check_schedule` calls `CronManager::updateSchedule()`
        //   - `enable_update_checks` toggling to '0'/'1' calls
        //     `CronManager::removeSchedule()` / re-derives the schedule and
        //     rewrites it, resetting/restoring the stored `update_check_schedule`
        //     row along the way.
        // Neither is implemented here: this plugin has no scheduler-service
        // equivalent yet to own writing root's crontab, and it must not write
        // it directly (see `src/schedules/cron.ts` — that module only computes
        // *when* a schedule should next run; nothing here writes cron files).
        // Once that service exists, port these two branches into it, not here.

        return this.db.write((db) => {
            const now = nowSeconds();
            const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
            if (existing !== undefined) {
                db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run(
                    stored,
                    now,
                    key
                );
            } else {
                db.prepare(
                    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
                ).run(key, stored, now);
            }
            return { key, value: stored };
        });
    }
}
