<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeProjectName.php';

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

/**
 * Issue #25: the name a Compose Manager stack runs under. The cases come from
 * one JSON table that the GraphQL plugin's test reads too, so the two
 * backends cannot drift apart.
 */
final class ComposeProjectNameTest extends TestCase
{
    private const CASES = __DIR__ . '/../../packages/unraid-api-plugin-docker-folders/src/compose/__tests__/project-name-cases.json';

    private static function table(string $key): array
    {
        $all = json_decode((string) file_get_contents(self::CASES), true);
        $out = [];
        foreach ($all[$key] as $i => $case) {
            $out[($case['why'] ?? json_encode($case)) . " #$i"] = [$case];
        }
        return $out;
    }

    public static function plusCases(): array { return self::table('plus'); }
    public static function dcflachsCases(): array { return self::table('dcflachs'); }
    public static function validCases(): array { return self::table('valid'); }
    public static function folderCases(): array { return self::table('folder'); }

    #[Test]
    #[DataProvider('plusCases')]
    public function plusSanitizerFollowsComposeManagerPlus(array $case): void
    {
        $this->assertSame($case['expect'], ComposeProjectName::plusSanitize($case['raw']));
    }

    #[Test]
    #[DataProvider('dcflachsCases')]
    public function dcflachsSanitizerFollowsSanitizeStr(array $case): void
    {
        $this->assertSame($case['expect'], ComposeProjectName::dcflachsSanitize($case['raw']));
    }

    #[Test]
    #[DataProvider('validCases')]
    public function validityIsTheComposeRule(array $case): void
    {
        $this->assertSame($case['expect'], ComposeProjectName::isValid($case['name']));
    }

    #[Test]
    #[DataProvider('folderCases')]
    public function folderNameFollowsTheRealPlugins(array $case): void
    {
        $got = ComposeProjectName::fromFolder($case['dir'], $case['display'], $case['pinned'], $case['plus'], $case['legacy']);
        $this->assertSame($case['expect'], $got['name']);
        $this->assertSame($case['expect'] === null, $got['error'] !== null);
    }

    private static function container(string $project, string $workingDir): array
    {
        return [
            'id' => "id-$project",
            'name' => "/$project-1",
            'labels' => [
                'com.docker.compose.project' => $project,
                'com.docker.compose.project.working_dir' => $workingDir,
            ],
        ];
    }

    #[Test]
    public function labelNameComesFromContainersRunningFromTheFolder(): void
    {
        $dir = '/boot/config/plugins/compose.manager/projects/Immich';
        $got = ComposeProjectName::fromLabels(
            [self::container('immich', $dir . '/'), self::container('other', '/mnt/user/appdata/other')],
            [$dir]
        );
        $this->assertSame(['name' => 'immich', 'error' => null], $got);
    }

    #[Test]
    public function noContainerGivesNoLabelName(): void
    {
        $got = ComposeProjectName::fromLabels([self::container('other', '/x')], ['/boot/config/plugins/compose.manager/projects/Immich']);
        $this->assertSame(['name' => null, 'error' => null], $got);
    }

    #[Test]
    public function twoProjectNamesFromOneFolderIsAnError(): void
    {
        $dir = '/p/Immich';
        $got = ComposeProjectName::fromLabels([self::container('a', $dir), self::container('b', $dir)], [$dir]);
        $this->assertNull($got['name']);
        $this->assertStringContainsString('more than one', $got['error']);
    }

    #[Test]
    public function aLabelNameComposeRefusesIsAnError(): void
    {
        $got = ComposeProjectName::fromLabels([self::container('Bad.Name', '/p/x')], ['/p/x']);
        $this->assertNull($got['name']);
        $this->assertNotNull($got['error']);
    }

    #[Test]
    public function aDotDotInTheWorkingDirDoesNotMatchAnotherFolder(): void
    {
        $got = ComposeProjectName::fromLabels([self::container('evil', '/p/Other/../Immich/../Other')], ['/p/Immich']);
        $this->assertSame(['name' => null, 'error' => null], $got);
    }
}
