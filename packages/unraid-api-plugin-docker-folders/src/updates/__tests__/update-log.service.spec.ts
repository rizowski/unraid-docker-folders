import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UpdateLogService } from '../update-log.service.js';

describe('UpdateLogService', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'docker-folders-update-log-'));
        path = join(dir, 'update-check.log');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes a line matching PHP\'s "[Y-m-d H:i:s] message" format', () => {
        const log = new UpdateLogService(path);

        log.log('START Manual update check begun');

        const content = readFileSync(path, 'utf8');
        expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] START Manual update check begun\n$/);
    });

    it('appends rather than overwrites across calls, and across service instances on the same path', () => {
        new UpdateLogService(path).log('first');
        new UpdateLogService(path).log('second');

        const lines = readFileSync(path, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('first');
        expect(lines[1]).toContain('second');
    });

    it('truncates once the file exceeds 64KB, keeping only whole trailing lines', () => {
        // Seed the file past the cap with fixed-width, individually
        // identifiable lines, bypassing the service's own timestamp so the
        // content is exact and predictable.
        const lineText = `x${'y'.repeat(199)}\n`; // 200 bytes/line
        const lines = Math.ceil((70 * 1024) / lineText.length);
        writeFileSync(path, lineText.repeat(lines));

        const log = new UpdateLogService(path);
        log.log('after truncation');

        const content = readFileSync(path);
        expect(content.length).toBeLessThan(70 * 1024);
        // No partial line at the start: the file starts exactly at a line
        // boundary, i.e. with 'x' (the seeded lines' first character) or with
        // the new '[' timestamp line if truncation dropped every seeded line.
        const firstChar = String.fromCharCode(content[0]);
        expect(['x', '[']).toContain(firstChar);
        expect(content.toString('utf8')).toContain('after truncation');
    });

    it('never throws when the directory does not exist', () => {
        const log = new UpdateLogService(join(dir, 'missing-subdir', 'update-check.log'));
        expect(() => log.log('anything')).not.toThrow();
    });
});
