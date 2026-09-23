import { describe, expect, it } from 'vitest';

import {
    normalizePath,
    pathIsWithin,
    pathIsWithinAny,
    resolveAgainst,
    safePathComponent,
    safeProjectName,
    sanitizeArchivePrefix,
} from '../paths.js';

/**
 * Ported case for case from `tests/php/PathSafetyTest.php`.
 *
 * The port is the point. Both backends read and write the same data while they
 * coexist, so a path the PHP side rejects and this one accepts is a hole that
 * only opens in GraphQL mode, which is the hardest kind to notice. Keeping the
 * same cases in both suites is what makes a divergence fail a test rather than
 * reach a user. If a case is added on either side, add it on the other.
 */
describe('normalizePath', () => {
    it.each([
        ['plain path', '/mnt/user/backups', '/mnt/user/backups'],
        ['collapses dot dot', '/mnt/../etc/shadow', '/etc/shadow'],
        ['collapses single dot', '/mnt/./user', '/mnt/user'],
        ['squeezes slashes', '/mnt//user///backups', '/mnt/user/backups'],
        ['strips trailing slash', '/mnt/user/backups/', '/mnt/user/backups'],
        ['root stays root', '/', '/'],
        ['dot dot above root', '/../../etc', '/etc'],
    ])('%s', (_name, input, expected) => {
        expect(normalizePath(input)).toBe(expected);
    });

    it.each([['.env'], ['../../etc/shadow'], ['']])('rejects the non-absolute %j', (input) => {
        expect(normalizePath(input)).toBeNull();
    });

    it('rejects a value that is not a string', () => {
        expect(normalizePath(null)).toBeNull();
        expect(normalizePath(undefined)).toBeNull();
    });
});

describe('pathIsWithin', () => {
    it('accepts a file under the base', () => {
        expect(pathIsWithin('/mnt/user/backups/x.tar.gz', '/mnt/user/backups')).toBe(true);
    });

    it('accepts the base itself', () => {
        expect(pathIsWithin('/mnt/user/backups', '/mnt/user/backups')).toBe(true);
    });

    // The original bug. A prefix test passes this, because realpath never
    // returns a trailing slash.
    it('rejects a sibling whose name starts with the base', () => {
        expect(pathIsWithin('/mnt/user/backups-evil/x.tar.gz', '/mnt/user/backups')).toBe(false);
    });

    it('rejects a path that climbs out of the base', () => {
        expect(pathIsWithin('/mnt/user/backups/../../../etc/shadow', '/mnt/user/backups')).toBe(
            false
        );
    });

    it('normalizes both sides before comparing', () => {
        expect(pathIsWithin('/mnt/user//backups/./x.tar.gz', '/mnt/user/backups/')).toBe(true);
    });

    // Bases can be label-derived (a stack working_dir, a mount Source), so a
    // weak base must fail closed rather than pass everything.
    it.each([['/'], [''], ['mnt/user'], ['/mnt/..']])(
        'fails closed on the weak base %j',
        (base) => {
            expect(pathIsWithin('/etc/shadow', base)).toBe(false);
        }
    );
});

describe('pathIsWithinAny', () => {
    const roots = ['/mnt', '/boot/config/plugins'];

    it('accepts a match in any root', () => {
        expect(pathIsWithinAny('/boot/config/plugins/foo/bar', roots)).toBe(true);
        expect(pathIsWithinAny('/mnt/user/appdata', roots)).toBe(true);
    });

    it('rejects sensitive targets', () => {
        expect(pathIsWithinAny('/etc/shadow', roots)).toBe(false);
        expect(pathIsWithinAny('/root/.ssh/id_rsa', roots)).toBe(false);
        expect(pathIsWithinAny('/var/local/emhttp/var.ini', roots)).toBe(false);
        expect(pathIsWithinAny('/boot/config/shadow', roots)).toBe(false);
        // Collapses out of /mnt entirely.
        expect(pathIsWithinAny('/mnt/../etc/shadow', roots)).toBe(false);
    });
});

describe('resolveAgainst', () => {
    it('resolves a relative path against the base', () => {
        expect(resolveAgainst('.env', '/mnt/user/appdata/blog')).toBe(
            '/mnt/user/appdata/blog/.env'
        );
    });

    it('passes an absolute path through normalized', () => {
        expect(resolveAgainst('/mnt/user//secrets/.env', '/mnt/user/appdata/blog')).toBe(
            '/mnt/user/secrets/.env'
        );
    });

    // A relative path is never normalized in isolation. It is joined first, so
    // the ".." segments collapse against the real base and then fail
    // containment, which is where the rejection belongs.
    it('lets containment catch a relative escape', () => {
        const workingDir = '/mnt/user/appdata/blog';
        const resolved = resolveAgainst('../../../../etc/shadow', workingDir);

        expect(resolved).toBe('/etc/shadow');
        expect(pathIsWithin(resolved, workingDir)).toBe(false);
    });

    // working_dir is nullable in the schema, and is null whenever the compose
    // labels did not supply one.
    it.each([[null], ['']])('rejects a relative path with the base %j', (base) => {
        expect(resolveAgainst('.env', base)).toBeNull();
    });

    it('rejects an empty path', () => {
        expect(resolveAgainst('', '/mnt/user/appdata/blog')).toBeNull();
    });
});

describe('safePathComponent', () => {
    it.each([
        ['*'],
        ['nginx*'],
        ['ngin?x'],
        ['nginx[0-9]'],
        ['{a,b}'],
        ['../nginx'],
        ['..'],
        ['.'],
        ['/etc/shadow'],
        [''],
        ['.hidden'],
        ['nginx\nroot'],
    ])('rejects %j', (value) => {
        expect(safePathComponent(value)).toBeNull();
    });

    it.each([['nginx'], ['my-app'], ['my_app'], ['project.service'], ['app2']])(
        'accepts the container-style name %j',
        (value) => {
            expect(safePathComponent(value)).toBe(value);
        }
    );

    // This and the container-name check on the container endpoint act on the
    // same values. If they drift, the API accepts names that backups cannot be
    // created for.
    it('agrees with the container name rule', () => {
        const containerNameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
        const candidates = [
            'nginx',
            'my-app',
            'my_app',
            'project.service',
            'app2',
            'A1',
            '*',
            'nginx*',
            '../nginx',
            '..',
            '.hidden',
            '',
            '/etc/shadow',
            'a\nb',
        ];

        for (const candidate of candidates) {
            expect(safePathComponent(candidate) !== null, `disagreement on ${JSON.stringify(candidate)}`).toBe(
                containerNameRegex.test(candidate)
            );
        }
    });
});

describe('sanitizeArchivePrefix', () => {
    // Every legitimate Docker or Compose name must survive unchanged, or
    // existing archives stop matching the glob that looks for them.
    it.each([['nginx'], ['my-app'], ['my_app'], ['blog.web'], ['app2'], ['myproject.db-1']])(
        'leaves %j alone',
        (value) => {
            expect(sanitizeArchivePrefix(value)).toBe(value);
        }
    );

    it.each([
        ['../../etc', 'etc'],
        ['nginx*', 'nginx-'],
        ['ngin?x', 'ngin-x'],
        ['nginx[0-9]', 'nginx-0-9-'],
        ['a/b', 'a-b'],
        ['.hidden', 'hidden'],
        ['-lead', 'lead'],
        ['nginx\nroot', 'nginx-root'],
    ])('coerces %j to %j', (input, expected) => {
        expect(sanitizeArchivePrefix(input)).toBe(expected);
    });

    it('answers null when nothing usable remains', () => {
        expect(sanitizeArchivePrefix('')).toBeNull();
        expect(sanitizeArchivePrefix('...')).toBeNull();
        expect(sanitizeArchivePrefix('///')).toBeNull();
    });
});

describe('safeProjectName', () => {
    it('accepts a compose project name', () => {
        expect(safeProjectName('my-stack')).toBe('my-stack');
        expect(safeProjectName('stack_1')).toBe('stack_1');
    });

    it('rejects anything that could reach the filesystem or the shell', () => {
        expect(safeProjectName('../evil')).toBeNull();
        expect(safeProjectName('a/b')).toBeNull();
        expect(safeProjectName('-leading-hyphen')).toBeNull();
        expect(safeProjectName('')).toBeNull();
        // Dots are legal in a container name but not in a project name.
        expect(safeProjectName('project.service')).toBeNull();
    });
});
