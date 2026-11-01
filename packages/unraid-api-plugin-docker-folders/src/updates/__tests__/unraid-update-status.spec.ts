import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    bareImageDigest,
    containerNamesForImage,
    markUnraidImageCurrent,
    pullDigestFromStatus,
    repairUnraidUpdateStatus,
    unraidImageKey,
    type UnraidStatusPaths,
} from '../unraid-update-status.js';
import keyFixture from './unraid-image-keys.fixture.json' with { type: 'json' };

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

describe('unraid-update-status (issue #23)', () => {
    let dir: string;
    let paths: UnraidStatusPaths;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'dfm-unraid-status-'));
        paths = { status: join(dir, 'unraid-update-status.json'), webui: join(dir, 'docker.json') };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 4));
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    it('builds the same key as Unraid’s ensureImageTag, and as the PHP port', () => {
        expect(keyFixture.length).toBeGreaterThan(0);
        for (const { image, key } of keyFixture) {
            expect(unraidImageKey(image), image).toBe(key);
        }
    });

    it('refuses an id or a digest reference', () => {
        expect(unraidImageKey(`sha256:${'a'.repeat(64)}`)).toBeNull();
        expect(unraidImageKey(`nginx@${D1}`)).toBeNull();
        expect(unraidImageKey('')).toBeNull();
    });

    it('reads bare digests and the pull stream’s Digest line', () => {
        expect(bareImageDigest(`lscr.io/linuxserver/sonarr@${D1}`)).toBe(D1);
        expect(bareImageDigest('sha256:abc')).toBeNull();
        expect(pullDigestFromStatus(`Digest: ${D1}`)).toBe(D1);
        expect(pullDigestFromStatus('Status: Downloaded newer image for nginx:latest')).toBeNull();
        expect(pullDigestFromStatus(undefined)).toBeNull();
    });

    it('writes Unraid’s entry and keeps every other one', () => {
        const other = { local: D2, remote: D2, status: 'true' };
        write(paths.status, {
            'lscr.io/linuxserver/sonarr:latest': { local: D2, remote: D1, status: 'false' },
            'library/redis:7': other,
        });

        expect(markUnraidImageCurrent('lscr.io/linuxserver/sonarr', D1, [], paths)).toBe(true);

        const data = read(paths.status);
        expect(data['lscr.io/linuxserver/sonarr:latest']).toEqual({ local: D1, remote: D1, status: 'true' });
        expect(data['library/redis:7']).toEqual(other);
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('creates a missing file and reads Unraid’s empty `[]`', () => {
        expect(markUnraidImageCurrent('nginx', `nginx@${D1}`, [], paths)).toBe(true);
        expect(read(paths.status)).toEqual({ 'library/nginx:latest': { local: D1, remote: D1, status: 'true' } });

        writeFileSync(paths.status, '[]');
        expect(markUnraidImageCurrent('nginx', D1, [], paths)).toBe(true);
    });

    it('leaves a file it cannot parse alone', () => {
        for (const content of ['{"truncated": ', '', '"a string"', '[1]']) {
            writeFileSync(paths.status, content);
            expect(markUnraidImageCurrent('nginx', D1, [], paths)).toBe(false);
            expect(readFileSync(paths.status, 'utf8')).toBe(content);
        }
    });

    it('writes nothing without a digest', () => {
        expect(markUnraidImageCurrent('nginx', null, ['web'], paths)).toBe(false);
        expect(existsSync(paths.status)).toBe(false);
    });

    it('keeps the file mode', () => {
        write(paths.status, {});
        chmodSync(paths.status, 0o600);
        markUnraidImageCurrent('nginx', D1, [], paths);
        expect(statSync(paths.status).mode & 0o777).toBe(0o600);
    });

    it('drops those containers from the Docker tab cache, and never creates it', () => {
        markUnraidImageCurrent('nginx', D1, ['web'], paths);
        expect(existsSync(paths.webui)).toBe(false);

        write(paths.webui, { sonarr: { updated: 'false', template: '/x.xml' }, radarr: { updated: 'true' } });
        markUnraidImageCurrent('lscr.io/linuxserver/sonarr', D1, ['sonarr'], paths);
        expect(Object.keys(read(paths.webui))).toEqual(['radarr']);
    });

    it('matches containers by Unraid key', () => {
        const containers = [
            { name: 'web', image: 'nginx' },
            { name: 'web2', image: 'library/nginx:latest' },
            { name: 'old', image: 'nginx:1.25' },
            { name: 'moved', image: `sha256:${'b'.repeat(64)}` },
        ];
        expect(containerNamesForImage(containers, 'nginx:latest')).toEqual(['web', 'web2']);
    });

    it('repairs only a flag whose remote digest is already on disk', async () => {
        write(paths.status, {
            'lscr.io/linuxserver/sonarr:latest': { local: D2, remote: D1, status: 'false' },
            'lscr.io/linuxserver/radarr:latest': { local: D2, remote: D1, status: 'false' },
            'library/redis:7': { local: D2, remote: D2, status: 'true' },
        });
        write(paths.webui, { sonarr: { updated: 'false' }, radarr: { updated: 'false' } });
        const asked: string[] = [];
        const digests: Record<string, string[]> = {
            'lscr.io/linuxserver/sonarr:latest': [`lscr.io/linuxserver/sonarr@${D1}`],
            'lscr.io/linuxserver/radarr:latest': [`lscr.io/linuxserver/radarr@${D2}`],
        };

        const repaired = await repairUnraidUpdateStatus(
            async (key) => {
                asked.push(key);
                return digests[key] ?? null;
            },
            [
                { name: 'sonarr', image: 'lscr.io/linuxserver/sonarr' },
                { name: 'radarr', image: 'lscr.io/linuxserver/radarr' },
            ],
            paths
        );

        expect(repaired).toEqual(['lscr.io/linuxserver/sonarr:latest']);
        const data = read(paths.status);
        expect(data['lscr.io/linuxserver/sonarr:latest']).toEqual({ local: D1, remote: D1, status: 'true' });
        expect((data['lscr.io/linuxserver/radarr:latest'] as { status: string }).status).toBe('false');
        expect(asked).not.toContain('library/redis:7');
        expect(Object.keys(read(paths.webui))).toEqual(['radarr']);
    });

    it('writes nothing when nothing is stale', async () => {
        const content = JSON.stringify({ 'library/redis:7': { local: D2, remote: D2, status: 'true' } });
        writeFileSync(paths.status, content);
        expect(await repairUnraidUpdateStatus(async () => null, [], paths)).toEqual([]);
        expect(readFileSync(paths.status, 'utf8')).toBe(content);
    });
});
