import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { imageFromTemplate, readAutostartMap, type TemplateSources } from '../unraid-templates.js';

describe('readAutostartMap and imageFromTemplate', () => {
    let dir: string;
    let autostartFile: string;
    let templateDir: string;
    let sources: TemplateSources;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'unraid-templates-'));
        autostartFile = join(dir, 'unraid-autostart');
        templateDir = join(dir, 'templates-user');
        mkdirSync(templateDir);
        sources = { autostartFile, templateDir };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function writeTemplate(name: string, xml: string) {
        writeFileSync(join(templateDir, name), xml, 'utf8');
    }

    describe('readAutostartMap', () => {
        it('reads one bare container name per line as autostarting', () => {
            writeFileSync(autostartFile, 'sonarr\nradarr\n', 'utf8');

            const map = readAutostartMap(sources);

            expect(map.get('sonarr')).toEqual({ autostart: true, autostartDelay: 0 });
            expect(map.get('radarr')).toEqual({ autostart: true, autostartDelay: 0 });
        });

        it('ignores blank lines and surrounding whitespace', () => {
            writeFileSync(autostartFile, '\n  sonarr  \n\n\t\n', 'utf8');

            const map = readAutostartMap(sources);

            expect([...map.keys()]).toEqual(['sonarr']);
            expect(map.get('sonarr')?.autostart).toBe(true);
        });

        it('takes the delay from the container template, and 0 when it is absent', () => {
            writeFileSync(autostartFile, 'sonarr\nradarr\n', 'utf8');
            writeTemplate(
                'my-sonarr.xml',
                '<Container><Name>sonarr</Name><AutostartDelay>15</AutostartDelay></Container>'
            );
            writeTemplate('my-radarr.xml', '<Container><Name>radarr</Name></Container>');

            const map = readAutostartMap(sources);

            expect(map.get('sonarr')?.autostartDelay).toBe(15);
            expect(map.get('radarr')?.autostartDelay).toBe(0);
        });

        // The map is keyed by the union of both sources, not just the autostart file.
        it('includes a container that only appears in a template, marked as not autostarting', () => {
            writeFileSync(autostartFile, '', 'utf8');
            writeTemplate(
                'my-lidarr.xml',
                '<Container><Name>lidarr</Name><AutostartDelay>5</AutostartDelay></Container>'
            );

            const map = readAutostartMap(sources);

            expect(map.get('lidarr')).toEqual({ autostart: false, autostartDelay: 5 });
        });

        it('returns an empty map when the autostart file and template directory are both missing', () => {
            const map = readAutostartMap({
                autostartFile: join(dir, 'does-not-exist'),
                templateDir: join(dir, 'also-missing'),
            });

            expect(map.size).toBe(0);
        });

        it('ignores a template file not named my-*.xml when reading delays', () => {
            writeFileSync(autostartFile, '', 'utf8');
            writeTemplate(
                'other-sonarr.xml',
                '<Container><Name>sonarr</Name><AutostartDelay>15</AutostartDelay></Container>'
            );

            const map = readAutostartMap(sources);

            expect(map.has('sonarr')).toBe(false);
        });
    });

    describe('imageFromTemplate', () => {
        it('prefers my-<name>.xml and returns its Repository', () => {
            writeTemplate(
                'my-sonarr.xml',
                '<Container><Name>sonarr</Name><Repository>lscr.io/linuxserver/sonarr</Repository></Container>'
            );

            expect(imageFromTemplate('sonarr', sources)).toBe('lscr.io/linuxserver/sonarr');
        });

        it('falls back to scanning every xml file for a matching Name when the prefixed file is missing', () => {
            writeTemplate(
                'unrelated-filename.xml',
                '<Container><Name>sonarr</Name><Repository>lscr.io/linuxserver/sonarr</Repository></Container>'
            );

            expect(imageFromTemplate('sonarr', sources)).toBe('lscr.io/linuxserver/sonarr');
        });

        it('returns null when no template matches', () => {
            expect(imageFromTemplate('sonarr', sources)).toBeNull();
        });

        it('returns null when Repository is present but empty', () => {
            writeTemplate('my-sonarr.xml', '<Container><Name>sonarr</Name><Repository></Repository></Container>');

            expect(imageFromTemplate('sonarr', sources)).toBeNull();
        });

        // basename() strips the traversal, so this must resolve inside templateDir and find nothing.
        it('cannot escape the template directory via a container name containing a path separator', () => {
            writeFileSync(join(dir, 'passwd'), 'root:x:0:0::/root:/bin/bash', 'utf8');

            expect(imageFromTemplate('../../etc/passwd', sources)).toBeNull();
        });
    });
});
