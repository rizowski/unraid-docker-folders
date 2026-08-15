<?php
/**
 * Unraid Docker Folders - Path safety helpers
 *
 * Shared validation for every path that originates from a request, or from a
 * database column that a request can write.
 *
 * Design notes:
 *
 * - Normalization is LEXICAL. realpath() returns false for a file that does not
 *   exist yet, and write targets must be validated before they are created.
 * - Containment compares against "$base" or "$base/" — the trailing separator is
 *   the whole point. A plain strpos() prefix test lets /mnt/user/backups-evil
 *   pass a /mnt/user/backups check.
 * - Containment FAILS CLOSED on a weak base. Some bases (a stack's working_dir,
 *   a mount Source) come from Docker labels and are attacker-influenced; a base
 *   of "/" would make the check pass for everything.
 *
 * @package UnraidDockerModern
 */

/**
 * Lexically normalize an absolute path.
 *
 * Collapses "." and "..", squeezes repeated slashes, and strips a trailing
 * slash. Does not touch the filesystem.
 *
 * @param string|null $path Absolute path
 * @return string|null Normalized path, or null if the input is not an absolute path
 */
function normalizePath($path)
{
  if (!is_string($path) || $path === '' || $path[0] !== '/') {
    return null;
  }

  $out = [];
  foreach (explode('/', $path) as $segment) {
    if ($segment === '' || $segment === '.') {
      continue;
    }
    if ($segment === '..') {
      // Popping an empty stack keeps us at "/" — ".." above root is still root,
      // which matches how the kernel resolves it.
      array_pop($out);
      continue;
    }
    $out[] = $segment;
  }

  return '/' . implode('/', $out);
}

/**
 * Join a possibly-relative path onto a base directory, then normalize.
 *
 * A relative path is never normalized on its own: "../../etc/shadow" has no base
 * to collapse against. Joining first is what turns the ".." segments into a path
 * that fails pathIsWithin().
 *
 * @param string|null $path Absolute or relative path
 * @param string|null $baseDir Absolute directory to resolve a relative path against
 * @return string|null Normalized absolute path, or null if it cannot be resolved
 */
function resolveAgainst($path, $baseDir)
{
  if (!is_string($path) || $path === '') {
    return null;
  }

  if ($path[0] === '/') {
    return normalizePath($path);
  }

  // Relative input needs a usable base.
  if (!is_string($baseDir) || $baseDir === '' || $baseDir[0] !== '/') {
    return null;
  }

  return normalizePath(rtrim($baseDir, '/') . '/' . $path);
}

/**
 * Is $path inside $base (or equal to it)?
 *
 * Fails closed when $base is empty, relative, or resolves to "/".
 *
 * @param string|null $path
 * @param string|null $base
 * @return bool
 */
function pathIsWithin($path, $base)
{
  $normalizedPath = normalizePath($path);
  $normalizedBase = normalizePath($base);

  if ($normalizedPath === null || $normalizedBase === null) {
    return false;
  }

  // A base of "/" would contain everything, which makes the check decoration.
  if ($normalizedBase === '/') {
    return false;
  }

  if ($normalizedPath === $normalizedBase) {
    return true;
  }

  return strpos($normalizedPath, $normalizedBase . '/') === 0;
}

/**
 * Is $path inside any of $bases?
 *
 * @param string|null $path
 * @param array $bases List of absolute directories
 * @return bool
 */
function pathIsWithinAny($path, array $bases)
{
  foreach ($bases as $base) {
    if (pathIsWithin($path, $base)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a compose project name.
 *
 * Extracted from ComposeManager::createStack, which has always applied this and
 * is the de-facto rule for project names in this codebase.
 *
 * @param string|null $name
 * @return string|null The name, or null if it is not acceptable
 */
function safeProjectName($name)
{
  if (!is_string($name) || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/', $name)) {
    return null;
  }
  return $name;
}

/**
 * Validate a single path segment used in a filename or a glob pattern.
 *
 * Rejects directory separators, "..", and the glob metacharacters * ? [ ] { },
 * which otherwise turn a filename prefix into a wildcard search.
 *
 * The accepted character set is deliberately the same as the container-name
 * check in api/containers.php: these operate on the same values (a container
 * name, or "project.service"), so they must not drift apart.
 *
 * @param string|null $value
 * @return string|null The value, or null if it is not acceptable
 */
function safePathComponent($value)
{
  if (!is_string($value) || $value === '' || $value === '.' || $value === '..') {
    return null;
  }
  if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]*$/', $value)) {
    return null;
  }
  return $value;
}

/**
 * Coerce a backup archive prefix into a safe filename component.
 *
 * Unlike safePathComponent() this REPLACES bad characters rather than rejecting
 * the value, because the prefix is a container name or "project.service" and
 * rejecting it would turn a working backup into a failure. Every legitimate
 * Docker/Compose name passes through unchanged.
 *
 * Archive naming and the prune/list globs must use this same function, or the
 * name written to disk stops matching the pattern used to find it later.
 *
 * @param string|null $value
 * @return string|null Sanitized prefix, or null if nothing usable remains
 */
function sanitizeArchivePrefix($value)
{
  if (!is_string($value) || $value === '') {
    return null;
  }

  // Everything outside the safe set becomes "-". This removes the directory
  // separators and the glob metacharacters * ? [ ] { } in one pass.
  $safe = preg_replace('/[^A-Za-z0-9._-]/', '-', $value);

  // Must start with an alphanumeric so the result cannot be "." or ".." and
  // cannot produce a hidden file.
  $safe = preg_replace('/^[^A-Za-z0-9]+/', '', $safe);

  return $safe === '' ? null : $safe;
}
