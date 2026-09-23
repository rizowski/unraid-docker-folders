/**
 * Path safety, ported from `include/paths.php`.
 *
 * Every path that comes from a request, or from a database column a request
 * can write, goes through here. The three rules below are the ones that are
 * easy to get wrong, and each of them is a bug this codebase has already had.
 *
 * 1. Normalization is LEXICAL. `realpath()` answers false for a file that does
 *    not exist yet, and a write target has to be checked before it is created,
 *    so nothing here touches the filesystem.
 * 2. A relative path is never normalized on its own. `../../etc/shadow` has no
 *    base to collapse against; joining it to its base first is what turns the
 *    `..` segments into something `pathIsWithin` rejects.
 * 3. Containment fails closed on a weak base: empty, relative, or `/`. Some
 *    bases are label-derived and attacker-influenced (a stack's `working_dir`,
 *    a mount `Source`), and a base of `/` would make the check decoration.
 *
 * And the original bug, which is why containment is not `startsWith`: a plain
 * prefix test lets `/mnt/user/backups-evil` pass a `/mnt/user/backups` check.
 * The trailing separator is the whole point.
 *
 * Kept behaviorally identical to the PHP, not improved. The two run against
 * the same data while both backends exist, so a difference here is a
 * difference in what each mode will accept.
 */

/**
 * Lexically normalize an absolute path.
 *
 * Collapses `.` and `..`, squeezes repeated slashes, and drops a trailing one.
 * Answers null for anything that is not an absolute path.
 */
export function normalizePath(path: string | null | undefined): string | null {
    if (typeof path !== 'string' || path === '' || path[0] !== '/') {
        return null;
    }

    const out: string[] = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') {
            // Popping an empty stack leaves us at "/". ".." above root is
            // still root, which is how the kernel resolves it too.
            out.pop();
            continue;
        }
        out.push(segment);
    }

    return `/${out.join('/')}`;
}

/** Join a possibly-relative path onto a base directory, then normalize. */
export function resolveAgainst(
    path: string | null | undefined,
    baseDir: string | null | undefined
): string | null {
    if (typeof path !== 'string' || path === '') return null;

    if (path[0] === '/') return normalizePath(path);

    // Relative input needs a usable base.
    if (typeof baseDir !== 'string' || baseDir === '' || baseDir[0] !== '/') {
        return null;
    }

    return normalizePath(`${baseDir.replace(/\/+$/, '')}/${path}`);
}

/** Is `path` inside `base`, or equal to it? Fails closed on a weak base. */
export function pathIsWithin(
    path: string | null | undefined,
    base: string | null | undefined
): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedBase = normalizePath(base);

    if (normalizedPath === null || normalizedBase === null) return false;

    // A base of "/" would contain everything.
    if (normalizedBase === '/') return false;

    if (normalizedPath === normalizedBase) return true;

    return normalizedPath.startsWith(`${normalizedBase}/`);
}

/** Is `path` inside any of `bases`? */
export function pathIsWithinAny(
    path: string | null | undefined,
    bases: readonly (string | null | undefined)[]
): boolean {
    return bases.some((base) => pathIsWithin(path, base));
}

/**
 * Validate a Compose project name.
 *
 * The rule `ComposeManager::createStack` has always applied, and the de-facto
 * one for project names throughout this codebase.
 */
export function safeProjectName(name: string | null | undefined): string | null {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
        return null;
    }
    return name;
}

/**
 * Validate one path segment used as a filename or a glob prefix.
 *
 * Rejects separators, `..`, and the glob metacharacters `* ? [ ] { }`, which
 * would otherwise turn a filename prefix into a wildcard search.
 *
 * The accepted set is deliberately the same as the container-name check on the
 * container endpoint: they operate on the same values (a container name, or
 * `project.service`), so they must not drift apart.
 */
export function safePathComponent(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || value === '' || value === '.' || value === '..') {
        return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return null;
    return value;
}

/**
 * Coerce a backup archive prefix into a safe filename component.
 *
 * This replaces bad characters instead of rejecting the value, unlike
 * `safePathComponent`. The prefix is a container name or `project.service`,
 * and rejecting it would turn a working backup into a failure. Every
 * legitimate Docker or Compose name passes through unchanged.
 *
 * Archive naming and the prune and list globs must all call this, or a name
 * written to disk stops matching the pattern used to find it later.
 */
export function sanitizeArchivePrefix(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || value === '') return null;

    // Everything outside the safe set becomes "-", which removes the
    // separators and the glob metacharacters in one pass.
    let safe = value.replace(/[^A-Za-z0-9._-]/g, '-');

    // Must start alphanumeric, so the result cannot be "." or ".." and cannot
    // produce a hidden file.
    safe = safe.replace(/^[^A-Za-z0-9]+/, '');

    return safe === '' ? null : safe;
}
