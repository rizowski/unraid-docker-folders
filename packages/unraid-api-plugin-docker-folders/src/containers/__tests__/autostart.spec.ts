import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isValidAutostartName, patchAutostartDelay, setAutostart } from '../autostart.js';
import type { TemplateSources } from '../unraid-templates.js';

describe('isValidAutostartName', () => {
    it('accepts the Docker container-name character set', () => {
        expect(isValidAutostartName('sonarr')).toBe(true);
        expect(isValidAutostartName('sonarr-4k_v2.1')).toBe(true);
        expect(isValidAutostartName('a..b')).toBe(true);
    });

    it('rejects a name starting with a separator or punctuation', () => {
        expect(isValidAutostartName('-sonarr')).toBe(false);
        expect(isValidAutostartName('.sonarr')).toBe(false);
        expect(isValidAutostartName('')).toBe(false);
    });

    it('rejects a path separator, blocking traversal and newline injection', () => {
        expect(isValidAutostartName('../etc/passwd')).toBe(false);
        expect(isValidAutostartName('sonarr/../radarr')).toBe(false);
        expect(isValidAutostartName('sonarr\nradarr')).toBe(false);
    });
});

describe('patchAutostartDelay', () => {
    it('replaces an existing element in place, leaving the rest of the file untouched', () => {
        const xml = '<Container>\n  <Name>sonarr</Name>\n  <AutostartDelay>5</AutostartDelay>\n</Container>\n';

        expect(patchAutostartDelay(xml, 15)).toBe(
            '<Container>\n  <Name>sonarr</Name>\n  <AutostartDelay>15</AutostartDelay>\n</Container>\n'
        );
    });

    it('inserts a new element before the root closing tag when absent', () => {
        const xml = '<Container>\n  <Name>sonarr</Name>\n</Container>\n';

        expect(patchAutostartDelay(xml, 10)).toBe(
            '<Container>\n  <Name>sonarr</Name>\n<AutostartDelay>10</AutostartDelay></Container>\n'
        );
    });

    it('leaves the file unchanged when no root closing tag can be found', () => {
        const xml = 'not xml at all';
        expect(patchAutostartDelay(xml, 5)).toBe(xml);
    });
});

describe('setAutostart', () => {
    let dir: string;
    let autostartFile: string;
    let templateDir: string;
    let sources: TemplateSources;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'autostart-'));
        autostartFile = join(dir, 'unraid-autostart');
        templateDir = join(dir, 'templates-user');
        mkdirSync(templateDir);
        sources = { autostartFile, templateDir };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a name outside the Docker container-name character set before touching any path', () => {
        expect(() => setAutostart('../etc/passwd', true, null, sources)).toThrow('Invalid container name');
    });

    it('creates the autostart file and appends the name when enabling for the first time', () => {
        const result = setAutostart('sonarr', true, null, sources);

        expect(result).toEqual({ success: true, autostart: true, autostartDelay: null });
        expect(readFileSync(autostartFile, 'utf8')).toBe('sonarr\n');
    });

    it('does not duplicate a name already listed', () => {
        writeFileSync(autostartFile, 'sonarr\nradarr\n', 'utf8');

        setAutostart('sonarr', true, null, sources);

        expect(readFileSync(autostartFile, 'utf8')).toBe('sonarr\nradarr\n');
    });

    it('removes a name in place, leaving every other name untouched', () => {
        writeFileSync(autostartFile, 'sonarr\nradarr\nlidarr\n', 'utf8');

        setAutostart('radarr', false, null, sources);

        expect(readFileSync(autostartFile, 'utf8')).toBe('sonarr\nlidarr\n');
    });

    it('writes a lone trailing newline when the file becomes empty', () => {
        writeFileSync(autostartFile, 'sonarr\n', 'utf8');

        setAutostart('sonarr', false, null, sources);

        expect(readFileSync(autostartFile, 'utf8')).toBe('\n');
    });

    it('clamps a negative delay to 0', () => {
        const result = setAutostart('sonarr', true, -5, sources);
        expect(result.autostartDelay).toBe(0);
    });

    it('leaves autostartDelay null, and writes no template, when delay is not sent', () => {
        writeFileSync(
            join(templateDir, 'my-sonarr.xml'),
            '<Container><Name>sonarr</Name><AutostartDelay>5</AutostartDelay></Container>',
            'utf8'
        );

        const result = setAutostart('sonarr', true, null, sources);

        expect(result.autostartDelay).toBeNull();
        expect(readFileSync(join(templateDir, 'my-sonarr.xml'), 'utf8')).toContain('<AutostartDelay>5</AutostartDelay>');
    });

    it('patches AutostartDelay in the my-<name>.xml template', () => {
        writeFileSync(
            join(templateDir, 'my-sonarr.xml'),
            '<Container>\n  <Name>sonarr</Name>\n  <AutostartDelay>5</AutostartDelay>\n</Container>\n',
            'utf8'
        );

        setAutostart('sonarr', true, 30, sources);

        expect(readFileSync(join(templateDir, 'my-sonarr.xml'), 'utf8')).toBe(
            '<Container>\n  <Name>sonarr</Name>\n  <AutostartDelay>30</AutostartDelay>\n</Container>\n'
        );
    });

    it('finds a template whose filename does not match the container name by scanning <Name>', () => {
        writeFileSync(
            join(templateDir, 'my-other-filename.xml'),
            '<Container><Name>sonarr</Name></Container>',
            'utf8'
        );

        setAutostart('sonarr', true, 20, sources);

        expect(readFileSync(join(templateDir, 'my-other-filename.xml'), 'utf8')).toContain(
            '<AutostartDelay>20</AutostartDelay>'
        );
    });

    it('does nothing to any template when none matches the container name', () => {
        writeFileSync(join(templateDir, 'my-radarr.xml'), '<Container><Name>radarr</Name></Container>', 'utf8');

        expect(() => setAutostart('sonarr', true, 20, sources)).not.toThrow();
        expect(readFileSync(join(templateDir, 'my-radarr.xml'), 'utf8')).toBe(
            '<Container><Name>radarr</Name></Container>'
        );
    });
});
