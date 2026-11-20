<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/FolderManager.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

/**
 * Issue #25: the import adopts a Compose Manager stack in place, and the
 * repair merges or renames the copies an earlier import made. Runs against an
 * in-memory SQLite with every migration applied and temp directories standing
 * in for the Compose Manager projects directory and COMPOSE_STACKS_DIR.
 */
final class ComposeImportRepairTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private Database $db;
    private ComposeManager $manager;
    private FolderManager $folders;
    private string $root;
    private string $projects;
    private string $stacks;
    private string $pluginDir;

    protected function setUp(): void
    {
        $ref = new ReflectionClass(Database::class);
        $this->db = $ref->newInstanceWithoutConstructor();
        $sqlite = new SQLite3(':memory:');
        $sqlite->exec('PRAGMA foreign_keys = ON');
        $prop = $ref->getProperty('db');
        $prop->setAccessible(true);
        $prop->setValue($this->db, $sqlite);

        $files = glob(self::MIGRATIONS_DIR . '/*.sql');
        sort($files);
        foreach ($files as $file) {
            $this->db->exec((string) file_get_contents($file));
        }

        $instance = $ref->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, $this->db);

        $this->manager = new ComposeManager();
        $this->folders = new FolderManager($this->db);

        $this->root = sys_get_temp_dir() . '/dfm-import-' . bin2hex(random_bytes(4));
        $this->projects = $this->root . '/compose.manager/projects';
        $this->stacks = $this->root . '/compose-stacks';
        $this->pluginDir = $this->root . '/plugin';
        mkdir($this->projects, 0755, true);
        mkdir($this->stacks, 0755, true);
        mkdir($this->pluginDir, 0755, true);
    }

    protected function tearDown(): void
    {
        $instance = (new ReflectionClass(Database::class))->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, null);

        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($this->root, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            ($item->isDir() && !$item->isLink()) ? rmdir($item->getPathname()) : unlink($item->getPathname());
        }
        rmdir($this->root);
    }

    // ─── helpers ──────────────────────────────────────────────────────

    /** A Compose Manager project folder. Returns its path. */
    private function project(string $dir, string $compose = "services: {}\n", array $extra = []): string
    {
        $path = $this->projects . '/' . $dir;
        mkdir($path, 0755, true);
        file_put_contents($path . '/docker-compose.yml', $compose);
        foreach ($extra as $name => $content) {
            file_put_contents($path . '/' . $name, $content);
        }
        return $path;
    }

    /** The copy and the row an earlier import made. Returns the copy's path. */
    private function oldCopy(string $dir, string $compose = "services: {}\n", ?string $env = null): string
    {
        $path = $this->stacks . '/' . $dir;
        mkdir($path, 0755, true);
        file_put_contents($path . '/docker-compose.yml', $compose);
        if ($env !== null) {
            file_put_contents($path . '/.env', $env);
        }
        $this->addRow($dir, $path, $path . '/docker-compose.yml', $env !== null ? $path . '/.env' : null, 'compose_plugin', 100);
        $this->addFolder($dir, $dir);
        return $path;
    }

    private function addRow(string $name, ?string $dir, ?string $file, ?string $env = null, ?string $imported = null, int $at = 200, array $more = []): void
    {
        $this->db->insert('compose_stacks', array_merge([
            'project_name' => $name,
            'working_dir' => $dir,
            'compose_file' => $file,
            'env_file' => $env,
            'autostart' => 0,
            'autostart_force_recreate' => 0,
            'description' => null,
            'imported_from' => $imported,
            'created_at' => $at,
            'updated_at' => $at,
        ], $more));
    }

    private function addFolder(string $name, ?string $project): int
    {
        $this->db->insert('folders', [
            'name' => $name, 'icon' => 'layer-group', 'color' => null, 'position' => 0, 'collapsed' => 0,
            'compose_project' => $project, 'created_at' => 1, 'updated_at' => 1,
        ]);
        return (int) $this->db->fetchValue('SELECT MAX(id) FROM folders');
    }

    private function addSchedule(string $target): int
    {
        $this->db->insert('schedules', [
            'name' => 's', 'target_type' => 'stack', 'target_id' => $target, 'action' => 'restart',
            'cron_expression' => '0 3 * * *', 'enabled' => 1, 'created_at' => 1, 'updated_at' => 1,
        ]);
        return (int) $this->db->fetchValue('SELECT MAX(id) FROM schedules');
    }

    private static function container(string $name, string $project, string $dir): array
    {
        return [
            'id' => "id-$name",
            'name' => "/$name",
            'labels' => [
                'com.docker.compose.project' => $project,
                'com.docker.compose.project.working_dir' => $dir,
                'com.docker.compose.project.config_files' => $dir . '/docker-compose.yml',
            ],
        ];
    }

    private function import(array $containers = []): array
    {
        return $this->manager->importFromComposePlugin($containers, $this->projects, $this->pluginDir, $this->stacks);
    }

    private function repair(): bool
    {
        return $this->manager->repairImportedStacks($this->projects, $this->pluginDir, $this->stacks);
    }

    /** @return string[] */
    private function names(): array
    {
        return array_column($this->db->fetchAll('SELECT project_name FROM compose_stacks ORDER BY project_name'), 'project_name');
    }

    private function row(string $name): ?array
    {
        return $this->db->fetchOne('SELECT * FROM compose_stacks WHERE project_name = ?', [$name]) ?: null;
    }

    private function folderCount(): int
    {
        return (int) $this->db->fetchValue('SELECT COUNT(*) FROM folders');
    }

    // ─── import ───────────────────────────────────────────────────────

    #[Test]
    public function importAdoptsTheFolderInPlaceWithoutCopyingFiles(): void
    {
        $path = $this->project('Immich', "services: {a: {}}\n", ['name' => 'Immich', 'description' => 'Photos']);

        $result = $this->import();

        $this->assertTrue($result['success']);
        $this->assertSame(1, $result['stacks_imported']);
        $this->assertSame(['immich'], $this->names());
        $row = $this->row('immich');
        $this->assertSame($path, $row['working_dir']);
        $this->assertSame($path . '/docker-compose.yml', $row['compose_file']);
        $this->assertNull($row['env_file']);
        $this->assertSame('compose_plugin', $row['imported_from']);
        $this->assertSame('Photos', $row['description']);
        $this->assertSame([], array_values(array_diff((array) scandir($this->stacks), ['.', '..'])));

        $folder = $this->db->fetchOne('SELECT * FROM folders');
        $this->assertSame('Immich', $folder['name']);
        $this->assertSame('immich', $folder['compose_project']);
    }

    #[Test]
    public function importNamesTheStackAfterItsRunningContainers(): void
    {
        $path = $this->project('Photos-Stack');
        $result = $this->import([self::container('web', 'my_photos', $path)]);

        $this->assertSame(1, $result['stacks_imported']);
        $this->assertSame(['my_photos'], $this->names());
    }

    #[Test]
    public function importNamesAStackByRuleWhenNothingRuns(): void
    {
        $this->project('Nginx.Test');
        $this->project('My_Stack', "services: {}\n", ['name' => 'Cool App']);

        $result = $this->import();

        $this->assertSame(2, $result['stacks_imported']);
        // dcflachs rule (no Plus): the name file when present, else the folder.
        $this->assertSame(['cool_app', 'nginx_test'], $this->names());
    }

    #[Test]
    public function importUsesAProjectNameFileAndTheComposeManagerPlusFolderRule(): void
    {
        $this->project('Pinned', "services: {}\n", ['project_name' => 'pin_me']);
        $this->project('My-App');
        mkdir($this->pluginDir . '/include', 0755, true);
        file_put_contents($this->pluginDir . '/include/ProjectIdentity.php', '<?php');

        $this->import();

        $this->assertSame(['my-app', 'pin_me'], $this->names());
    }

    #[Test]
    public function importSkipsAStackWhoseNameComposeRefuses(): void
    {
        $this->project('web@home');
        $this->project('Good');

        $result = $this->import();

        $this->assertTrue($result['success']);
        $this->assertSame(1, $result['stacks_imported']);
        $this->assertSame(['good'], $this->names());
        $this->assertCount(1, $result['errors']);
        $this->assertStringContainsString('web@home', $result['errors'][0]);
    }

    #[Test]
    public function importSkipsAStackWhoseContainersDisagreeOnTheName(): void
    {
        $path = $this->project('Immich');
        $result = $this->import([self::container('a', 'one', $path), self::container('b', 'two', $path)]);

        $this->assertSame(0, $result['stacks_imported']);
        $this->assertSame([], $this->names());
        $this->assertStringContainsString('more than one', $result['errors'][0]);
    }

    #[Test]
    public function importAdoptsTheRowTheLabelSyncMadeAndAddsNoSecondOne(): void
    {
        $path = $this->project('Immich', "services: {}\n", ['autostart' => 'true', 'description' => 'Photos']);
        $containers = [self::container('immich-server-1', 'immich', $path)];

        // The sync saw the running stack first.
        $this->folders->syncComposeStacks($containers);
        $this->assertSame(['immich'], $this->names());
        $this->assertNull($this->row('immich')['imported_from']);

        $result = $this->import($containers);

        $this->assertSame(1, $result['stacks_imported']);
        $this->assertSame(['immich'], $this->names());
        $row = $this->row('immich');
        $this->assertSame('compose_plugin', $row['imported_from']);
        $this->assertSame('Photos', $row['description']);
        $this->assertSame(1, (int) $row['autostart']);
        $this->assertSame(1, $this->folderCount());
        $this->assertFalse($this->manager->hasComposePluginData());
    }

    #[Test]
    public function aSecondImportAndAFollowingSyncAddNothing(): void
    {
        $path = $this->project('Immich');
        $containers = [self::container('immich-server-1', 'immich', $path)];

        $this->import($containers);
        $again = $this->import($containers);
        $this->folders->syncComposeStacks($containers);

        $this->assertSame(0, $again['stacks_imported']);
        $this->assertSame(1, $again['stacks_skipped']);
        $this->assertSame(['immich'], $this->names());
        $this->assertSame(1, $this->folderCount());
        $this->assertSame($path, $this->row('immich')['working_dir']);
    }

    #[Test]
    public function importRefusesToTakeOverAStackAtAnotherPath(): void
    {
        $this->project('Immich');
        $this->addRow('immich', '/mnt/user/appdata/immich', '/mnt/user/appdata/immich/docker-compose.yml');

        $result = $this->import();

        $this->assertSame(0, $result['stacks_imported']);
        $this->assertStringContainsString('another path', $result['errors'][0]);
        $this->assertSame('/mnt/user/appdata/immich', $this->row('immich')['working_dir']);
    }

    #[Test]
    public function twoFoldersWithTheSameProjectNameImportOnlyOnce(): void
    {
        $this->project('Immich');
        $this->project('immich');

        $result = $this->import();

        $this->assertSame(1, $result['stacks_imported']);
        $this->assertCount(1, $result['errors']);
        $this->assertSame(['immich'], $this->names());
    }

    #[Test]
    public function importOfAnIndirectStackPointsAtItsTarget(): void
    {
        $target = $this->root . '/appdata/blog';
        mkdir($target, 0755, true);
        file_put_contents($target . '/compose.yaml', "services: {}\n");
        $this->project('Blog', "", ['indirect' => $target]);
        unlink($this->projects . '/Blog/docker-compose.yml');

        $result = $this->import();

        $this->assertSame(1, $result['stacks_imported']);
        $row = $this->row('blog');
        $this->assertSame($target, $row['working_dir']);
        $this->assertSame($target . '/compose.yaml', $row['compose_file']);
    }

    #[Test]
    public function importSkipsAnIndirectStackWhoseTargetIsGone(): void
    {
        $this->project('Blog', "", ['indirect' => $this->root . '/missing']);

        $result = $this->import();

        $this->assertSame(0, $result['stacks_imported']);
        $this->assertStringContainsString('indirect', $result['errors'][0]);
    }

    #[Test]
    public function importLeavesAnUnmatchedOldCopyAloneInsteadOfAddingAnotherRow(): void
    {
        // The copy differs from the source, so the repair leaves it, and the
        // import must not add a second row for the same folder.
        $this->project('Immich', "services: {new: {}}\n");
        $this->oldCopy('Immich', "services: {old: {}}\n");

        $result = $this->import();

        $this->assertSame(0, $result['stacks_imported']);
        $this->assertSame(['Immich'], $this->names());
        $this->assertStringContainsString('earlier import', $result['errors'][0]);
    }

    // ─── repair ───────────────────────────────────────────────────────

    #[Test]
    public function repairMergesTheCopyIntoTheRowTheLabelsMade(): void
    {
        $source = $this->project('Immich', "services: {}\n");
        $copy = $this->oldCopy('Immich');
        $this->addRow('immich', $source, $source . '/docker-compose.yml', null, null, 300);
        $this->addFolder('immich', 'immich');
        $this->db->update('compose_stacks', ['description' => 'Photos', 'autostart' => 1], 'project_name = ?', ['Immich']);
        $scheduleId = $this->addSchedule('Immich');

        // A saved version, with its snapshot file in the copy.
        mkdir($copy . '/.versions');
        file_put_contents($copy . '/.versions/5-compose.yml', "old\n");
        $this->db->insert('compose_file_versions', [
            'project_name' => 'Immich', 'file_type' => 'compose', 'file_path' => '.versions/5-compose.yml',
            'content_hash' => md5("old\n"), 'created_at' => 5,
        ]);
        $versionId = (int) $this->db->fetchValue('SELECT id FROM compose_file_versions');

        $this->assertTrue($this->repair());

        $this->assertSame(['immich'], $this->names());
        $row = $this->row('immich');
        $this->assertSame('compose_plugin', $row['imported_from']);
        $this->assertSame('Photos', $row['description']);
        $this->assertSame(1, (int) $row['autostart']);
        $this->assertSame('immich', $this->db->fetchValue('SELECT target_id FROM schedules WHERE id = ?', [$scheduleId]));

        // The version resolves through the surviving row, and its file was copied, not moved.
        $got = $this->manager->getFileVersionContent('immich', $versionId);
        $this->assertTrue($got['success'], $got['error'] ?? '');
        $this->assertSame("old\n", $got['version']['content']);
        $this->assertFileExists($copy . '/.versions/5-compose.yml');

        // The imported folder was empty and goes. One folder is left.
        $this->assertSame(1, $this->folderCount());
        $this->assertSame('immich', $this->db->fetchValue('SELECT compose_project FROM folders'));

        // No file on disk was removed.
        $this->assertFileExists($copy . '/docker-compose.yml');
        $this->assertFileExists($source . '/docker-compose.yml');
    }

    #[Test]
    public function repairDetachesAnImportedFolderThatHoldsContainers(): void
    {
        $source = $this->project('Immich');
        $this->oldCopy('Immich');
        $this->addRow('immich', $source, $source . '/docker-compose.yml');
        $kept = $this->addFolder('immich', 'immich');
        $mine = (int) $this->db->fetchValue("SELECT id FROM folders WHERE compose_project = 'Immich'");
        $this->db->insert('container_folders', ['container_id' => 'x', 'container_name' => 'photos-1', 'folder_id' => $mine, 'position' => 0]);

        $this->assertTrue($this->repair());

        $this->assertNull($this->db->fetchValue('SELECT compose_project FROM folders WHERE id = ?', [$mine]));
        $this->assertSame('immich', $this->db->fetchValue('SELECT compose_project FROM folders WHERE id = ?', [$kept]));
        $this->assertSame(1, (int) $this->db->fetchValue('SELECT COUNT(*) FROM container_folders WHERE folder_id = ?', [$mine]));
    }

    #[Test]
    public function repairHandsTheImportedFolderToTheRowWhenItHasNone(): void
    {
        $source = $this->project('Immich');
        $this->oldCopy('Immich');
        $this->addRow('immich', $source, $source . '/docker-compose.yml');

        $this->repair();

        $this->assertSame(1, $this->folderCount());
        $this->assertSame('Immich', $this->db->fetchValue('SELECT name FROM folders'));
        $this->assertSame('immich', $this->db->fetchValue('SELECT compose_project FROM folders'));
    }

    #[Test]
    public function repairNeverMergesTwoStacksOnAMatchingNameAlone(): void
    {
        // "Nginx.Test" sanitizes to "nginx_test", but the other row runs from an
        // unrelated folder. Same name after the rule is no proof of one stack.
        $this->oldCopy('Nginx.Test');
        $elsewhere = $this->root . '/appdata/nginx';
        mkdir($elsewhere, 0755, true);
        $this->addRow('nginx_test', $elsewhere, $elsewhere . '/docker-compose.yml');

        $this->assertFalse($this->repair());

        $this->assertSame(['Nginx.Test', 'nginx_test'], $this->names());
    }

    #[Test]
    public function repairDoesNotRenameOntoTheNameOfAnUnrelatedStack(): void
    {
        $this->project('Nginx.Test');
        $this->oldCopy('Nginx.Test');
        $elsewhere = $this->root . '/appdata/nginx';
        mkdir($elsewhere, 0755, true);
        $this->addRow('nginx_test', $elsewhere, $elsewhere . '/docker-compose.yml');

        $this->assertFalse($this->repair());

        $this->assertSame(['Nginx.Test', 'nginx_test'], $this->names());
        $this->assertSame($elsewhere, $this->row('nginx_test')['working_dir']);
    }

    #[Test]
    public function repairLeavesTheRowAloneWhenTwoRowsFitEqually(): void
    {
        $source = $this->project('Immich');
        $this->oldCopy('Immich');
        $this->addRow('immich', $source, $source . '/docker-compose.yml');
        $this->addRow('immich_two', $source, $source . '/docker-compose.yml');

        $this->assertFalse($this->repair());
        $this->assertSame(['Immich', 'immich', 'immich_two'], $this->names());
    }

    #[Test]
    public function repairRenamesAStoppedStackWhenTheCopyMatchesTheSource(): void
    {
        $source = $this->project('Nginx.Test', "services: {a: {}}\n", ['.env' => "A=1\n"]);
        $copy = $this->oldCopy('Nginx.Test', "services: {a: {}}\n", "A=1\n");
        $scheduleId = $this->addSchedule('Nginx.Test');
        $this->db->update('compose_stacks', ['autostart' => 1, 'description' => 'Web'], 'project_name = ?', ['Nginx.Test']);

        $this->assertTrue($this->repair());

        $this->assertSame(['nginx_test'], $this->names());
        $row = $this->row('nginx_test');
        $this->assertSame($source, $row['working_dir']);
        $this->assertSame($source . '/docker-compose.yml', $row['compose_file']);
        $this->assertNull($row['env_file']);
        $this->assertSame(1, (int) $row['autostart']);
        $this->assertSame('Web', $row['description']);
        $this->assertSame('compose_plugin', $row['imported_from']);
        $this->assertSame('nginx_test', $this->db->fetchValue('SELECT target_id FROM schedules WHERE id = ?', [$scheduleId]));
        $this->assertSame('nginx_test', $this->db->fetchValue('SELECT compose_project FROM folders'));
        $this->assertFileExists($copy . '/docker-compose.yml');
    }

    #[Test]
    public function repairRepointsARowThatAlreadyHasAValidName(): void
    {
        $source = $this->project('immich');
        $this->oldCopy('immich');

        $this->assertTrue($this->repair());

        $this->assertSame(['immich'], $this->names());
        $this->assertSame($source, $this->row('immich')['working_dir']);
    }

    /** @return array<string, array{0: callable}> */
    public static function leaveAloneCases(): array
    {
        return [
            'copy differs from the source' => [function (self $t) {
                $t->project('Immich', "services: {a: {}}\n");
                $t->oldCopy('Immich', "services: {edited: {}}\n");
            }],
            'source folder is gone' => [function (self $t) {
                $t->oldCopy('Immich');
            }],
            'the copy env differs' => [function (self $t) {
                $t->project('Immich', "services: {}\n", ['.env' => "A=1\n"]);
                $t->oldCopy('Immich', "services: {}\n", "A=2\n");
            }],
            'name Compose refuses' => [function (self $t) {
                $t->project('web@home');
                $t->oldCopy('web@home');
            }],
        ];
    }

    #[Test]
    #[\PHPUnit\Framework\Attributes\DataProvider('leaveAloneCases')]
    public function repairLeavesTheRowAlone(callable $setup): void
    {
        $setup($this);
        $before = $this->db->fetchAll('SELECT * FROM compose_stacks ORDER BY project_name');
        $foldersBefore = $this->db->fetchAll('SELECT * FROM folders ORDER BY id');

        $changed = $this->repair();

        $this->assertSame($before, $this->db->fetchAll('SELECT * FROM compose_stacks ORDER BY project_name'));
        $this->assertSame($foldersBefore, $this->db->fetchAll('SELECT * FROM folders ORDER BY id'));
        $this->assertFalse($changed);
    }

    #[Test]
    public function repairIsIdempotentAndWritesNothingTheSecondTime(): void
    {
        $source = $this->project('Immich');
        $this->oldCopy('Immich');
        $this->addRow('immich', $source, $source . '/docker-compose.yml');

        $this->assertTrue($this->repair());
        $rows = $this->db->fetchAll('SELECT * FROM compose_stacks');
        $folders = $this->db->fetchAll('SELECT * FROM folders');

        $this->assertFalse($this->repair());
        $this->assertSame($rows, $this->db->fetchAll('SELECT * FROM compose_stacks'));
        $this->assertSame($folders, $this->db->fetchAll('SELECT * FROM folders'));
    }

    #[Test]
    public function repairDoesNothingWithoutACopyRow(): void
    {
        $source = $this->project('Immich');
        $this->addRow('immich', $source, null, null, 'compose_plugin');
        $this->addRow('other', $this->stacks . '/other', null, null, null);

        $this->assertFalse($this->repair());
        $this->assertSame(['immich', 'other'], $this->names());
    }

    #[Test]
    public function repairRollsBackWhenAWriteFails(): void
    {
        $source = $this->project('Immich');
        $this->oldCopy('Immich');
        $this->addRow('immich', $source, $source . '/docker-compose.yml');
        // A trigger that makes the last write of the merge fail.
        $this->db->exec("CREATE TRIGGER boom BEFORE DELETE ON compose_stacks BEGIN SELECT RAISE(ABORT, 'boom'); END");
        $before = $this->db->fetchAll('SELECT * FROM schedules');
        $this->addSchedule('Immich');

        // SQLite3 raises a PHP warning for the failed statement, and the repair
        // logs it. Both are expected here, so keep them out of the test output.
        $log = ini_set('error_log', '/dev/null');
        set_error_handler(static fn (): bool => true, E_WARNING);
        try {
            $this->assertFalse($this->repair());
        } finally {
            restore_error_handler();
            ini_set('error_log', $log === false ? '' : $log);
        }

        $this->assertSame(['Immich', 'immich'], $this->names());
        $this->assertSame('Immich', $this->db->fetchValue('SELECT target_id FROM schedules'));
        $this->assertSame([], $before);
    }

    #[Test]
    public function theSyncRunsTheRepairEvenWithNoComposeContainer(): void
    {
        // Real constants: nothing is under COMPOSE_STACKS_DIR here, so no row is a copy.
        $this->assertFalse($this->folders->syncComposeStacks([]));
        $this->assertFalse($this->folders->syncComposeStacks([['id' => 'a', 'name' => '/a', 'labels' => []]]));
    }
}
