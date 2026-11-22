import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    bareImageDigest,
    containerNamesForImage,
    containersBehindImage,
    encodeUnraidJson,
    markUnraidImageCurrent,
    pickUnraidDigest,
    pullDigestFromStatus,
    readUnraidJson,
    repairUnraidUpdateStatus,
    unraidImageKey,
    updateUnraidJson,
    type UnraidStatusPaths,
} from '../unraid-update-status.js';
import jsonFixture from './unraid-json.fixture.json' with { type: 'json' };
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
        for (const content of ['{"truncated": ', '', '"a string"']) {
            // A list is no longer here: Unraid's loadJSON() reads one, so item 12 reads it too.
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

    it('finds containers on the tag that run another image', () => {
        const containers = [
            { name: 'web', image: 'nginx', imageId: 'sha256:new' },
            { name: 'web2', image: 'nginx:latest', imageId: 'sha256:old' },
            { name: 'other', image: 'nginx:1.25', imageId: 'sha256:old' },
            { name: 'unknown', image: 'nginx' },
        ];
        expect(containersBehindImage(containers, 'nginx', 'sha256:new')).toEqual(['web2', 'unknown']);
    });

    it('picks the pull digest, else a candidate that is on disk', () => {
        expect(pickUnraidDigest(D1, [], [D2])).toBe(D1);
        expect(pickUnraidDigest(null, [`repo@${D2}`], [D1, D2])).toBe(D2);
        expect(pickUnraidDigest(null, [`repo@${D2}`], [D1, null])).toBeNull();
    });

    it('repairs only a flag whose remote digest is already on disk', async () => {
        write(paths.status, {
            'lscr.io/linuxserver/sonarr:latest': { local: D2, remote: D1, status: 'false' },
            'lscr.io/linuxserver/radarr:latest': { local: D2, remote: D1, status: 'false' },
            'library/redis:7': { local: D2, remote: D2, status: 'true' },
        });
        write(paths.webui, { sonarr: { updated: 'false' }, radarr: { updated: 'false' } });
        const asked: string[] = [];
        const images: Record<string, { id: string; repoDigests: string[] }> = {
            'lscr.io/linuxserver/sonarr:latest': { id: 'sha256:s', repoDigests: [`lscr.io/linuxserver/sonarr@${D1}`] },
            'lscr.io/linuxserver/radarr:latest': { id: 'sha256:r', repoDigests: [`lscr.io/linuxserver/radarr@${D2}`] },
        };

        const repaired = await repairUnraidUpdateStatus(
            async (key) => {
                asked.push(key);
                return images[key] ?? null;
            },
            [
                { name: 'sonarr', image: 'lscr.io/linuxserver/sonarr', imageId: 'sha256:s' },
                { name: 'radarr', image: 'lscr.io/linuxserver/radarr', imageId: 'sha256:r' },
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

    it('does not repair while a container on the tag runs an older image', async () => {
        const content = JSON.stringify({ 'library/nginx:latest': { local: D2, remote: D1, status: 'false' } });
        writeFileSync(paths.status, content);
        const repaired = await repairUnraidUpdateStatus(
            async () => ({ id: 'sha256:new', repoDigests: [`nginx@${D1}`] }),
            [{ name: 'web', image: 'nginx', imageId: 'sha256:old' }],
            paths
        );
        expect(repaired).toEqual([]);
        expect(readFileSync(paths.status, 'utf8')).toBe(content);
    });

    describe('Unraid’s JSON form (loadJSON and saveJSON)', () => {
        // loadJSON(): a file that decodes to nothing reads as an empty map.
        const decode = (input: string) => {
            writeFileSync(paths.status, input);
            return readUnraidJson(paths.status) ?? {};
        };
        const writeAndRead = (input: unknown) => {
            writeFileSync(paths.status, JSON.stringify(input));
            expect(updateUnraidJson(paths.status, (fresh) => fresh)).toBe(true);
            return readFileSync(paths.status, 'utf8');
        };

        it('writes the same bytes as Unraid’s saveJSON for every fixture input', () => {
            expect(jsonFixture.length).toBeGreaterThan(0);
            for (const { input, output } of jsonFixture) {
                if (input.endsWith(' + key')) {
                    const merged = decode(input.slice(0, -' + key'.length));
                    merged['lscr.io/linuxserver/sonarr:latest'] = { status: 'true' };
                    expect(encodeUnraidJson(merged), input).toBe(output);
                    continue;
                }
                expect(encodeUnraidJson(decode(input)), input).toBe(output);
            }
        });

        it('reads a non-empty list as PHP does, and adds keys to it', () => {
            writeFileSync(paths.status, '["a","b"]');
            const data = readUnraidJson(paths.status);
            expect(data).toEqual({ '0': 'a', '1': 'b' });
            expect(markUnraidImageCurrent('nginx', D1, [], paths)).toBe(true);
            expect(read(paths.status)).toMatchObject({ '0': 'a', '1': 'b', 'library/nginx:latest': { status: 'true' } });
        });

        it('writes an empty map as [] and escapes Unicode, not slashes', () => {
            expect(writeAndRead({})).toBe('[]');
            expect(writeAndRead({ 'a/b': 'é☃' })).toBe('{\n    "a/b": "\\u00e9\\u2603"\n}');
        });
    });

    it('leaves a flag alone when no container uses the tag', async () => {
        const content = JSON.stringify({ 'library/nginx:latest': { local: D2, remote: D1, status: 'false' } });
        writeFileSync(paths.status, content);
        const inspect = async () => ({ id: 'sha256:new', repoDigests: [`nginx@${D1}`] });
        expect(await repairUnraidUpdateStatus(inspect, [], paths)).toEqual([]);
        expect(
            await repairUnraidUpdateStatus(inspect, [{ name: 'db', image: 'postgres', imageId: 'sha256:p' }], paths)
        ).toEqual([]);
        expect(readFileSync(paths.status, 'utf8')).toBe(content);
    });

    it('keeps keys another writer added between the read and the write', async () => {
        write(paths.status, { 'library/nginx:latest': { local: D2, remote: D1, status: 'false' } });
        const repaired = await repairUnraidUpdateStatus(
            async () => {
                // Unraid's own check adds a key while the repair inspects the image.
                write(paths.status, {
                    'library/nginx:latest': { local: D2, remote: D1, status: 'false' },
                    'library/redis:7': { local: D2, remote: D2, status: 'true' },
                });
                return { id: 'sha256:n', repoDigests: [`nginx@${D1}`] };
            },
            [{ name: 'web', image: 'nginx', imageId: 'sha256:n' }],
            paths
        );
        expect(repaired).toEqual(['library/nginx:latest']);
        const data = read(paths.status);
        expect((data['library/nginx:latest'] as { status: string }).status).toBe('true');
        expect((data['library/redis:7'] as { status: string }).status).toBe('true');
    });

    it('leaves an entry another writer changed after the first read', async () => {
        write(paths.status, { 'library/nginx:latest': { local: D2, remote: D1, status: 'false' } });
        const moved = `sha256:${'3'.repeat(64)}`;
        const repaired = await repairUnraidUpdateStatus(
            async () => {
                write(paths.status, { 'library/nginx:latest': { local: D2, remote: moved, status: 'false' } });
                return { id: 'sha256:n', repoDigests: [`nginx@${D1}`] };
            },
            [{ name: 'web', image: 'nginx', imageId: 'sha256:n' }],
            paths
        );
        expect(repaired).toEqual([]);
        expect((read(paths.status)['library/nginx:latest'] as { status: string }).status).toBe('false');
    });

    it('writes nothing when nothing is stale', async () => {
        const content = JSON.stringify({ 'library/redis:7': { local: D2, remote: D2, status: 'true' } });
        writeFileSync(paths.status, content);
        expect(await repairUnraidUpdateStatus(async () => null, [], paths)).toEqual([]);
        expect(readFileSync(paths.status, 'utf8')).toBe(content);
    });
});
