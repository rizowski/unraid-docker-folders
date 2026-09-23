import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PATH_SUGGEST_LIMIT, PathBrowserService, splitTypedPath } from '../path-browser.service.js';

/**
 * Checked against `api/paths.php` on the live server first: 54 cases over six
 * real containers, including traversal attempts and an injection-shaped
 * container name, with no disagreement. These cases keep the rules that matter
 * with directories made up for the test.
 */
describe('PathBrowserService', () => {
    let root: string;

    beforeEach(() => {
        // Resolved, because macOS puts the temp directory behind a symlink and
        // every entry is compared by its real path. A mount whose Source is
        // itself behind a symlink lists nothing, in PHP as well as here.
        root = realpathSync(mkdtempSync(join(tmpdir(), 'dfm-paths-')));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    function withMounts(mounts: { Source: string; Destination: string }[]) {
        return new PathBrowserService({
            listContainers: async () => [],
            getContainer: () => ({ inspect: async () => ({ Mounts: mounts }) }),
        });
    }

    describe('host scope', () => {
        it('offers the roots until the user types past one', () => {
            const service = withMounts([]);
            expect(service.suggestHostPaths('', [`${root}/a`, `${root}/b`]).entries).toHaveLength(2);
            expect(service.suggestHostPaths(`${root}/a`, [`${root}/a`, `${root}/b`]).entries).toEqual([
                { name: `${root}/a`, path: `${root}/a` },
            ]);
        });

        it('lists directories under a root, filtered by a case-insensitive prefix', () => {
            mkdirSync(`${root}/share/Appdata`, { recursive: true });
            mkdirSync(`${root}/share/apps`, { recursive: true });
            mkdirSync(`${root}/share/media`, { recursive: true });
            writeFileSync(`${root}/share/app.txt`, 'a file, not a directory');

            const result = withMounts([]).suggestHostPaths(`${root}/share/ap`, [`${root}/share`]);

            expect(result.base).toBe(`${root}/share`);
            expect(result.entries.map((e) => e.name)).toEqual(['Appdata', 'apps']);
        });

        // The typed path is normalized before containment, so climbing out
        // with dot-dot lands outside the root and lists nothing.
        it('refuses to list outside the roots, however the path is spelled', () => {
            mkdirSync(`${root}/share`, { recursive: true });
            mkdirSync(`${root}/secret`, { recursive: true });
            const service = withMounts([]);

            expect(service.suggestHostPaths(`${root}/secret/`, [`${root}/share`]).entries).toEqual([]);
            expect(service.suggestHostPaths(`${root}/share/../secret/`, [`${root}/share`]).entries).toEqual([]);
            expect(service.suggestHostPaths('share/', [`${root}/share`]).entries).toEqual([]);
        });

        // PHP's scandir sorts, and the PHP takes the first fifty of those.
        it('takes the first fifty in sorted order, not in directory order', () => {
            for (let i = 99; i >= 0; i--) mkdirSync(`${root}/share/d${String(i).padStart(3, '0')}`, { recursive: true });

            const names = withMounts([]).suggestHostPaths(`${root}/share/`, [`${root}/share`]).entries.map((e) => e.name);

            expect(names).toHaveLength(PATH_SUGGEST_LIMIT);
            expect(names[0]).toBe('d000');
            expect(names[PATH_SUGGEST_LIMIT - 1]).toBe('d049');
        });
    });

    describe('container scope', () => {
        it('offers the mount points before a path inside one is typed', async () => {
            const service = withMounts([
                { Source: `${root}/cfg`, Destination: '/config' },
                { Source: `${root}/data`, Destination: '/data' },
            ]);

            const result = await service.suggestContainerPaths('plex', '/c');

            expect(result.entries).toEqual([{ name: '/config', path: '/config' }]);
        });

        it('lists the host directory under a mount, in container terms', async () => {
            mkdirSync(`${root}/cfg/Library`, { recursive: true });
            const service = withMounts([{ Source: `${root}/cfg`, Destination: '/config' }]);

            const result = await service.suggestContainerPaths('plex', '/config/');

            expect(result.base).toBe('/config');
            expect(result.entries).toEqual([{ name: 'Library', path: '/config/Library' }]);
        });

        // Every entry is resolved and rechecked, so a symlink inside a share
        // cannot turn the browser into a listing of somewhere else.
        it('drops a symlink that leads out of the mount', async () => {
            mkdirSync(`${root}/cfg`, { recursive: true });
            mkdirSync(`${root}/outside/private`, { recursive: true });
            symlinkSync(`${root}/outside`, `${root}/cfg/escape`);
            mkdirSync(`${root}/cfg/real`, { recursive: true });
            const service = withMounts([{ Source: `${root}/cfg`, Destination: '/config' }]);

            const result = await service.suggestContainerPaths('plex', '/config/');

            expect(result.entries.map((e) => e.name)).toEqual(['real']);
        });

        it('refuses a container name that could not be a container', async () => {
            const service = withMounts([{ Source: `${root}/cfg`, Destination: '/config' }]);

            expect((await service.suggestContainerPaths('../etc', '/')).entries).toEqual([]);
            expect((await service.suggestContainerPaths('nope; rm -rf', '/')).entries).toEqual([]);
        });

        it('notices a SQLite database in the listed directory', async () => {
            mkdirSync(`${root}/cfg/db`, { recursive: true });
            writeFileSync(`${root}/cfg/db/app.db`, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)]));
            const service = withMounts([{ Source: `${root}/cfg`, Destination: '/config' }]);

            expect((await service.suggestContainerPaths('plex', '/config/db/')).has_sqlite).toBe(true);
            expect((await service.suggestContainerPaths('plex', '/config/')).has_sqlite).toBe(false);
        });
    });

    describe('splitTypedPath', () => {
        it.each([
            ['', ['', '']],
            ['/', ['/', '']],
            ['/mnt/', ['/mnt', '']],
            ['/mnt/us', ['/mnt', 'us']],
            ['/mnt', ['/', 'mnt']],
            ['plex', ['', 'plex']],
        ])('splits %j', (typed, expected) => {
            expect(splitTypedPath(typed)).toEqual(expected);
        });
    });
});
