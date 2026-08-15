<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/paths.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

final class PathSafetyTest extends TestCase
{
    // ─── normalizePath ────────────────────────────────────────────────

    public static function normalizeCases(): array
    {
        return [
            'plain path'            => ['/mnt/user/backups', '/mnt/user/backups'],
            'collapses dot dot'     => ['/mnt/../etc/shadow', '/etc/shadow'],
            'collapses single dot'  => ['/mnt/./user', '/mnt/user'],
            'squeezes slashes'      => ['/mnt//user///backups', '/mnt/user/backups'],
            'strips trailing slash' => ['/mnt/user/backups/', '/mnt/user/backups'],
            'root stays root'       => ['/', '/'],
            'dot dot above root'    => ['/../../etc', '/etc'],
        ];
    }

    #[Test]
    #[DataProvider('normalizeCases')]
    public function normalizePath_normalizes(string $input, string $expected): void
    {
        $this->assertSame($expected, normalizePath($input));
    }

    public static function nonAbsoluteCases(): array
    {
        return [
            'relative'      => ['.env'],
            'relative climb' => ['../../etc/shadow'],
            'empty'         => [''],
        ];
    }

    #[Test]
    #[DataProvider('nonAbsoluteCases')]
    public function normalizePath_rejects_non_absolute(string $input): void
    {
        $this->assertNull(normalizePath($input));
    }

    // ─── pathIsWithin ─────────────────────────────────────────────────

    #[Test]
    public function pathIsWithin_accepts_a_child(): void
    {
        $this->assertTrue(pathIsWithin('/mnt/user/backups/x.tar.gz', '/mnt/user/backups'));
    }

    #[Test]
    public function pathIsWithin_accepts_the_base_itself(): void
    {
        $this->assertTrue(pathIsWithin('/mnt/user/backups', '/mnt/user/backups'));
    }

    /**
     * The bug this whole helper exists for: a bare strpos() prefix test accepts
     * a sibling directory that merely starts with the same characters.
     */
    #[Test]
    public function pathIsWithin_rejects_a_sibling_sharing_the_prefix(): void
    {
        $this->assertFalse(pathIsWithin('/mnt/user/backups-evil/x.tar.gz', '/mnt/user/backups'));
    }

    #[Test]
    public function pathIsWithin_rejects_a_traversal_escape(): void
    {
        $this->assertFalse(pathIsWithin('/mnt/user/backups/../../../etc/shadow', '/mnt/user/backups'));
    }

    #[Test]
    public function pathIsWithin_normalizes_before_comparing(): void
    {
        $this->assertTrue(pathIsWithin('/mnt/user//backups/./x.tar.gz', '/mnt/user/backups/'));
    }

    public static function weakBaseCases(): array
    {
        return [
            'root base'     => ['/'],
            'empty base'    => [''],
            'relative base' => ['mnt/user'],
            'base collapsing to root' => ['/mnt/..'],
        ];
    }

    /**
     * Bases can be label-derived (a stack working_dir, a mount Source), so a
     * weak base must fail closed rather than pass everything.
     */
    #[Test]
    #[DataProvider('weakBaseCases')]
    public function pathIsWithin_fails_closed_on_a_weak_base(string $base): void
    {
        $this->assertFalse(pathIsWithin('/etc/shadow', $base));
    }

    // ─── pathIsWithinAny ──────────────────────────────────────────────

    #[Test]
    public function pathIsWithinAny_accepts_a_match_in_any_root(): void
    {
        $roots = ['/mnt', '/boot/config/plugins'];
        $this->assertTrue(pathIsWithinAny('/boot/config/plugins/foo/bar', $roots));
        $this->assertTrue(pathIsWithinAny('/mnt/user/appdata', $roots));
    }

    #[Test]
    public function pathIsWithinAny_rejects_sensitive_targets(): void
    {
        $roots = ['/mnt', '/boot/config/plugins'];
        $this->assertFalse(pathIsWithinAny('/etc/shadow', $roots));
        $this->assertFalse(pathIsWithinAny('/root/.ssh/id_rsa', $roots));
        $this->assertFalse(pathIsWithinAny('/var/local/emhttp/var.ini', $roots));
        $this->assertFalse(pathIsWithinAny('/boot/config/shadow', $roots));
        // The normalization case: this collapses out of /mnt entirely.
        $this->assertFalse(pathIsWithinAny('/mnt/../etc/shadow', $roots));
    }

    // ─── resolveAgainst ───────────────────────────────────────────────

    #[Test]
    public function resolveAgainst_resolves_a_relative_path_against_the_base(): void
    {
        $this->assertSame(
            '/mnt/user/appdata/blog/.env',
            resolveAgainst('.env', '/mnt/user/appdata/blog')
        );
    }

    #[Test]
    public function resolveAgainst_passes_an_absolute_path_through_normalized(): void
    {
        $this->assertSame(
            '/mnt/user/secrets/.env',
            resolveAgainst('/mnt/user//secrets/.env', '/mnt/user/appdata/blog')
        );
    }

    /**
     * A relative path is never normalized in isolation — it is joined first, so
     * the ".." segments collapse against the real base and then fail containment.
     */
    #[Test]
    public function resolveAgainst_lets_containment_catch_a_relative_escape(): void
    {
        $workingDir = '/mnt/user/appdata/blog';
        $resolved = resolveAgainst('../../../../etc/shadow', $workingDir);

        $this->assertSame('/etc/shadow', $resolved);
        $this->assertFalse(pathIsWithin($resolved, $workingDir));
    }

    public static function missingBaseCases(): array
    {
        return [
            'null base'  => [null],
            'empty base' => [''],
        ];
    }

    /**
     * working_dir is nullable in the schema and is NULL whenever the compose
     * labels did not supply one, so a relative path has nothing to resolve against.
     */
    #[Test]
    #[DataProvider('missingBaseCases')]
    public function resolveAgainst_rejects_a_relative_path_with_no_base(?string $base): void
    {
        $this->assertNull(resolveAgainst('.env', $base));
    }

    #[Test]
    public function resolveAgainst_rejects_an_empty_path(): void
    {
        $this->assertNull(resolveAgainst('', '/mnt/user/appdata/blog'));
    }

    // ─── safePathComponent ────────────────────────────────────────────

    public static function unsafeComponents(): array
    {
        return [
            'star'            => ['*'],
            'prefix star'     => ['nginx*'],
            'question mark'   => ['ngin?x'],
            'bracket'         => ['nginx[0-9]'],
            'brace'           => ['{a,b}'],
            'slash'           => ['../nginx'],
            'bare dot dot'    => ['..'],
            'bare dot'        => ['.'],
            'absolute'        => ['/etc/shadow'],
            'empty'           => [''],
            'leading dot'     => ['.hidden'],
            'newline'         => ["nginx\nroot"],
        ];
    }

    #[Test]
    #[DataProvider('unsafeComponents')]
    public function safePathComponent_rejects_unsafe_values(string $value): void
    {
        $this->assertNull(safePathComponent($value));
    }

    public static function safeComponents(): array
    {
        return [
            'simple'          => ['nginx'],
            'with hyphen'     => ['my-app'],
            'with underscore' => ['my_app'],
            'with dot'        => ['project.service'],
            'digits'          => ['app2'],
        ];
    }

    #[Test]
    #[DataProvider('safeComponents')]
    public function safePathComponent_accepts_container_style_names(string $value): void
    {
        $this->assertSame($value, safePathComponent($value));
    }

    /**
     * safePathComponent and the container-name check in api/containers.php act on
     * the same values (a container name, or "project.service"). If they drift,
     * the API accepts names that backups cannot be created for.
     */
    #[Test]
    public function safePathComponent_agrees_with_the_container_name_regex(): void
    {
        $containerNameRegex = '/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/';
        $candidates = [
            'nginx', 'my-app', 'my_app', 'project.service', 'app2', 'A1',
            '*', 'nginx*', '../nginx', '..', '.hidden', '', '/etc/shadow', "a\nb",
        ];

        foreach ($candidates as $candidate) {
            $this->assertSame(
                (bool) preg_match($containerNameRegex, $candidate),
                safePathComponent($candidate) !== null,
                "Disagreement on: " . var_export($candidate, true)
            );
        }
    }

    // ─── sanitizeArchivePrefix ────────────────────────────────────────

    public static function untouchedPrefixes(): array
    {
        return [
            'container name'    => ['nginx'],
            'hyphenated'        => ['my-app'],
            'underscored'       => ['my_app'],
            'project.service'   => ['blog.web'],
            'digits'            => ['app2'],
            'compose style'     => ['myproject.db-1'],
        ];
    }

    /**
     * Every legitimate Docker/Compose name must survive unchanged, or existing
     * archives stop matching the glob that looks for them.
     */
    #[Test]
    #[DataProvider('untouchedPrefixes')]
    public function sanitizeArchivePrefix_leaves_legitimate_names_alone(string $value): void
    {
        $this->assertSame($value, sanitizeArchivePrefix($value));
    }

    public static function coercedPrefixes(): array
    {
        return [
            'traversal'      => ['../../etc', 'etc'],
            'star'           => ['nginx*', 'nginx-'],
            'question'       => ['ngin?x', 'ngin-x'],
            'brackets'       => ['nginx[0-9]', 'nginx-0-9-'],
            'slash'          => ['a/b', 'a-b'],
            'leading dot'    => ['.hidden', 'hidden'],
            'leading dash'   => ['-lead', 'lead'],
            'newline'        => ["nginx\nroot", 'nginx-root'],
        ];
    }

    #[Test]
    #[DataProvider('coercedPrefixes')]
    public function sanitizeArchivePrefix_coerces_unsafe_values(string $input, string $expected): void
    {
        $this->assertSame($expected, sanitizeArchivePrefix($input));
    }

    #[Test]
    public function sanitizeArchivePrefix_returns_null_when_nothing_usable_remains(): void
    {
        $this->assertNull(sanitizeArchivePrefix(''));
        $this->assertNull(sanitizeArchivePrefix('...'));
        $this->assertNull(sanitizeArchivePrefix('///'));
    }

    /**
     * The output must always be usable as a filename segment. If this ever fails,
     * a sanitized prefix could still carry a separator or a glob metacharacter
     * into the archive name.
     */
    #[Test]
    public function sanitizeArchivePrefix_output_is_always_a_safe_component(): void
    {
        $inputs = ['../../etc', 'nginx*', 'a/b', '.hidden', "x\ny", 'nginx[0-9]', 'my-app', 'blog.web'];

        foreach ($inputs as $input) {
            $result = sanitizeArchivePrefix($input);
            if ($result === null) {
                continue;
            }
            $this->assertNotNull(
                safePathComponent($result),
                "sanitizeArchivePrefix left an unsafe component for: " . var_export($input, true)
            );
        }
    }

    // ─── safeProjectName ──────────────────────────────────────────────

    #[Test]
    public function safeProjectName_accepts_valid_names(): void
    {
        $this->assertSame('my-stack', safeProjectName('my-stack'));
        $this->assertSame('stack_1', safeProjectName('stack_1'));
    }

    #[Test]
    public function safeProjectName_rejects_traversal_and_separators(): void
    {
        $this->assertNull(safeProjectName('../evil'));
        $this->assertNull(safeProjectName('a/b'));
        $this->assertNull(safeProjectName('-leading-hyphen'));
        $this->assertNull(safeProjectName(''));
        // Dots are valid in container names but not in compose project names.
        $this->assertNull(safeProjectName('project.service'));
    }
}
