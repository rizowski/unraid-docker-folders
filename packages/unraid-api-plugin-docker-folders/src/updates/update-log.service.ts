import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { detectServerTimezone } from '../util/timezone.js';

/**
 * Appends timestamped lines to `update-check.log`, ported from `logUpdate()`
 * in `config.php`.
 *
 * Written for real this time — an earlier revision of this port deliberately
 * skipped writing this file, reasoning that two backends writing it
 * concurrently would race the way `ContainerListService` avoids racing
 * `/tmp/unraid-docker-container-facts-v3.json`. That reasoning does not apply
 * here: `backend_mode` gates which backend runs background work at all
 * (settings.service.ts), so only one of PHP's cron / this service's
 * `runScheduledCheck()` is ever appending at a time. `settings.php`'s
 * `DockerFolders.page` log viewer reads this file's last 100 lines as plain
 * text (`file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES)`), so the
 * `[Y-m-d H:i:s] message` line shape has to match exactly.
 */
export const CONFIG_DIR = '/boot/config/plugins/unraid-docker-folders-modern';

/** Overrides the log path. Only the tests supply one. */
export const UPDATE_LOG_PATH_TOKEN = 'DOCKER_FOLDERS_UPDATE_LOG_PATH';

export const DEFAULT_UPDATE_LOG_PATH = `${CONFIG_DIR}/update-check.log`;

/** `UPDATE_LOG_MAX_BYTES` in `config.php`: 64 KB. */
const MAX_BYTES = 64 * 1024;

@Injectable()
export class UpdateLogService {
    private readonly logger = new Logger(UpdateLogService.name);

    constructor(
        @Optional()
        @Inject(UPDATE_LOG_PATH_TOKEN)
        private readonly path: string = DEFAULT_UPDATE_LOG_PATH
    ) {}

    log(message: string): void {
        const line = `[${formatTimestamp(new Date(), detectServerTimezone())}] ${message}\n`;
        try {
            // The 'a' flag opens with O_APPEND, so the write itself — like
            // PHP's FILE_APPEND — is atomic against another writer's append.
            // Nothing here matches PHP's LOCK_EX around it: that only
            // protects the truncate step below, and this plugin does not
            // need it (see the class doc).
            appendFileSync(this.path, line, { flag: 'a' });
        } catch (error) {
            this.logger.warn(`Could not write ${this.path}: ${String(error)}`);
            return;
        }
        this.truncateIfNeeded();
    }

    /**
     * Keeps the file's own last-100-lines viewer fast without unbounded
     * growth. Operates on bytes, like PHP's `substr`/`filesize` — a
     * character-based `String#slice` would cut a multi-byte UTF-8 sequence
     * in half.
     */
    private truncateIfNeeded(): void {
        let size: number;
        try {
            size = statSync(this.path).size;
        } catch {
            return;
        }
        if (size <= MAX_BYTES) return;

        let content: Buffer;
        try {
            content = readFileSync(this.path);
        } catch {
            return;
        }

        // Keep the newest 75%, then drop the (likely partial) first line of
        // what's kept, so every remaining line is whole.
        let keep = content.subarray(-Math.trunc(MAX_BYTES * 0.75));
        const newline = keep.indexOf(0x0a);
        if (newline !== -1) {
            keep = keep.subarray(newline + 1);
        }

        try {
            writeFileSync(this.path, keep);
        } catch (error) {
            this.logger.warn(`Could not truncate ${this.path}: ${String(error)}`);
        }
    }
}

/** `date('Y-m-d H:i:s')` after PHP's `date_default_timezone_set(detectServerTimezone())`. */
function formatTimestamp(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
