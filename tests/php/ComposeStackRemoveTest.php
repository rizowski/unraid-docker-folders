<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/FolderManager.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

/**
 * Issue #25: removing a compose stack. Runs against an in-memory SQLite with every migration
 * applied, and a temp directory standing in for COMPOSE_STACKS_DIR.
 */
final class ComposeStackRemoveTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private Database $db;
    private ComposeManager $manager;
    private FolderManager $folders;
    private string $root;
    private string $stacksDir;

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

        $this->root = sys_get_temp_dir() . '/dfm-stack-' . bin2hex(random_bytes(4));
        $this->stacksDir = $this->root . '/compose-stacks';
        mkdir($this->stacksDir, 0755, true);
    }

    protected function tearDown(): void
    {
        $instance = (new ReflectionClass(Database::class))->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, null);

        // Not glob(GLOB_BRACE): musl has none.
        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($this->root, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            ($item->isDir() && !$item->isLink()) ? rmdir($item->getPathname()) : unlink($item->getPathname());
        }
        rmdir($this->root);
    }

    private function addStack(string $name, ?string $workingDir = null, ?string $composeFile = null, ?string $envFile = null, int $createdAt = 100): void
    {
        $this->db->insert('compose_stacks', [
            'project_name' => $name,
            'working_dir' => $workingDir,
            'compose_file' => $composeFile,
            'env_file' => $envFile,
            'autostart' => 0,
            'autostart_force_recreate' => 0,
            'description' => null,
            'imported_from' => null,
            'created_at' => $createdAt,
            'updated_at' => $createdAt,
        ]);
    }

    /** A stack whose copy lives under the stacks dir, as import makes it. */
    private function addOwnStack(string $name, int $createdAt = 100): string
    {
        $dir = $this->stacksDir . '/' . $name;
        mkdir($dir);
        file_put_contents($dir . '/docker-compose.yml', "services: {}\n");
        file_put_contents($dir . '/.env', "A=1\n");
        $this->addStack($name, $dir, $dir . '/docker-compose.yml', $dir . '/.env', $createdAt);
        return $dir;
    }

    private static function labelled(string $name, string $project): array
    {
        return [
            'id' => "id-$name",
            'name' => "/$name",
            'labels' => [
                'com.docker.compose.project' => $project,
                'com.docker.compose.project.working_dir' => '/boot/config/plugins/compose.manager/projects/Immich',
                'com.docker.compose.project.config_files' => '/boot/config/plugins/compose.manager/projects/Immich/docker-compose.yml',
            ],
        ];
    }

    /** @return string[] */
    private function stackNames(): array
    {
        return array_column($this->db->fetchAll('SELECT project_name FROM compose_stacks ORDER BY project_name'), 'project_name');
    }

    // ─── removal ───────────────────────────────────────────────────

    // ─── A: removal ───────────────────────────────────────────────────

    #[Test]
    public function isOwnStackPathIsTrueOnlyForADirectChildOfTheStacksDirectory(): void
    {
        $base = '/boot/config/plugins/x/compose-stacks';
        $this->assertTrue(ComposeManager::isOwnStackPath($base . '/demo', $base));
        $this->assertFalse(ComposeManager::isOwnStackPath($base, $base));
        $this->assertFalse(ComposeManager::isOwnStackPath($base . '/demo/deeper', $base));
        $this->assertFalse(ComposeManager::isOwnStackPath($base . '/../demo', $base));
        $this->assertFalse(ComposeManager::isOwnStackPath($base . '-evil/demo', $base));
        $this->assertFalse(ComposeManager::isOwnStackPath('/boot/config/plugins/compose.manager/projects/Demo', $base));
        $this->assertFalse(ComposeManager::isOwnStackPath(null, $base));
    }

    #[Test]
    public function removingAnUnknownStackIsNotFound(): void
    {
        $result = $this->manager->removeStack('nope', false, [], $this->stacksDir);
        $this->assertFalse($result['success']);
        $this->assertSame('not_found', $result['code']);
    }

    #[Test]
    public function removalDeletesTheRowItsVersionsItsSchedulesAndItsFolderButNotTheFiles(): void
    {
        $dir = $this->addOwnStack('Immich');
        $this->db->insert('compose_file_versions', [
            'project_name' => 'Immich', 'file_type' => 'compose', 'file_path' => '.versions/1-compose.yml',
            'content_hash' => 'h', 'created_at' => 1,
        ]);
        $now = time();
        foreach (['Immich', 'other'] as $target) {
            $this->db->insert('schedules', [
                'name' => 's', 'target_type' => 'stack', 'target_id' => $target, 'action' => 'restart',
                'cron_expression' => '0 3 * * *', 'enabled' => 1, 'created_at' => $now, 'updated_at' => $now,
            ]);
        }
        $this->folders->createFolder(['name' => 'Immich', 'icon' => 'layer-group', 'compose_project' => 'Immich']);

        $result = $this->manager->removeStack('Immich', false, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertSame(1, $result['schedules_removed']);
        $this->assertSame('deleted', $result['folder']);
        $this->assertSame([], $this->stackNames());
        $this->assertSame(0, (int) $this->db->fetchValue('SELECT COUNT(*) FROM compose_file_versions'));
        $this->assertSame(['other'], array_column($this->db->fetchAll('SELECT target_id FROM schedules'), 'target_id'));
        $this->assertSame(0, (int) $this->db->fetchValue('SELECT COUNT(*) FROM folders'));
        $this->assertFileExists($dir . '/docker-compose.yml', 'files stay unless asked for');
        $this->assertSame([], $result['files_removed']);
    }

    #[Test]
    public function aFolderHoldingAnotherProjectsLiveContainerStaysAsAPlainFolder(): void
    {
        $this->addOwnStack('Immich');
        $folder = $this->folders->createFolder(['name' => 'Immich', 'icon' => 'layer-group', 'compose_project' => 'Immich']);
        $this->folders->addContainerToFolder((int) $folder['id'], 'id-web', 'web');

        $result = $this->manager->removeStack('Immich', false, [self::labelled('web', 'other')], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertSame('kept', $result['folder']);
        $this->assertNull($this->db->fetchValue('SELECT compose_project FROM folders WHERE id = ?', [$folder['id']]));
        $this->assertSame(['web'], array_column($this->folders->getFolder((int) $folder['id'])['containers'], 'container_name'));
    }

    #[Test]
    public function aFolderHoldingAPlainContainerStaysAsAPlainFolder(): void
    {
        $this->addOwnStack('Immich');
        $folder = $this->folders->createFolder(['name' => 'Immich', 'icon' => 'layer-group', 'compose_project' => 'Immich']);
        $this->folders->addContainerToFolder((int) $folder['id'], 'id-plex', 'plex');
        $plex = ['id' => 'id-plex', 'name' => '/plex', 'labels' => []];

        $result = $this->manager->removeStack('Immich', false, [$plex], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertSame('kept', $result['folder']);
        $this->assertSame(['plex'], array_column($this->folders->getFolder((int) $folder['id'])['containers'], 'container_name'));
    }

    #[Test]
    public function removalIsRefusedWhileContainersOfTheOnlyRowExist(): void
    {
        $this->addOwnStack('Immich');

        // The label is the stack's own name.
        $result = $this->manager->removeStack('Immich', true, [self::labelled('immich_server', 'Immich')], $this->stacksDir);

        $this->assertFalse($result['success']);
        $this->assertSame('in_use', $result['code']);
        $this->assertStringContainsString('Stack Down', $result['error']);
        $this->assertSame(['Immich'], $this->stackNames());
        $this->assertFileExists($this->stacksDir . '/Immich/docker-compose.yml');
    }

    #[Test]
    public function deleteFilesRemovesTheOwnCopyAndItsDirectory(): void
    {
        $dir = $this->addOwnStack('Immich');

        $result = $this->manager->removeStack('Immich', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertEqualsCanonicalizing(['docker-compose.yml', '.env'], $result['files_removed']);
        $this->assertTrue($result['directory_removed']);
        $this->assertDirectoryDoesNotExist($dir);
    }

    #[Test]
    public function deleteFilesAlsoTakesTheVersionSnapshots(): void
    {
        $dir = $this->addOwnStack('Immich');
        mkdir($dir . '/.versions');
        file_put_contents($dir . '/.versions/1700000000-compose.yml', 'old');
        file_put_contents($dir . '/.versions/1700000000-env.env', 'old');

        $result = $this->manager->removeStack('Immich', true, [], $this->stacksDir);

        $this->assertTrue($result['directory_removed']);
        $this->assertDirectoryDoesNotExist($dir);
    }

    #[Test]
    public function aFileThePluginDidNotWriteKeepsTheDirectory(): void
    {
        $dir = $this->addOwnStack('Immich');
        mkdir($dir . '/data');
        file_put_contents($dir . '/data/library.db', 'precious');

        $result = $this->manager->removeStack('Immich', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertFalse($result['directory_removed']);
        $this->assertFileExists($dir . '/data/library.db');
        $this->assertFileDoesNotExist($dir . '/docker-compose.yml');
        $this->assertNotNull($result['files_note']);
    }

    #[Test]
    public function aComposeManagerDirectoryIsNeverDeleted(): void
    {
        $outside = $this->root . '/compose.manager/projects/Immich';
        mkdir($outside, 0755, true);
        file_put_contents($outside . '/docker-compose.yml', 'services: {}');
        $this->addStack('Immich', $outside, $outside . '/docker-compose.yml');

        $result = $this->manager->removeStack('Immich', true, [], $this->stacksDir);

        $this->assertTrue($result['success'], 'the row still goes');
        $this->assertSame([], $result['files_removed']);
        $this->assertFileExists($outside . '/docker-compose.yml');
        $this->assertNotNull($result['files_note']);
    }

    #[Test]
    public function theStacksDirectoryItselfIsNeverDeleted(): void
    {
        file_put_contents($this->stacksDir . '/docker-compose.yml', 'services: {}');
        $this->addStack('Odd', $this->stacksDir, $this->stacksDir . '/docker-compose.yml');

        $result = $this->manager->removeStack('Odd', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertDirectoryExists($this->stacksDir);
        $this->assertFileExists($this->stacksDir . '/docker-compose.yml');
    }

    #[Test]
    public function aDotDotWorkingDirDoesNotEscape(): void
    {
        $victim = $this->root . '/victim';
        mkdir($victim);
        file_put_contents($victim . '/docker-compose.yml', 'keep');
        $this->addStack('Sneaky', $this->stacksDir . '/../victim', null);

        $result = $this->manager->removeStack('Sneaky', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertFileExists($victim . '/docker-compose.yml');
    }

    #[Test]
    public function aSiblingWithTheSamePrefixIsNotInside(): void
    {
        $evil = $this->root . '/compose-stacks-evil/x';
        mkdir($evil, 0755, true);
        file_put_contents($evil . '/docker-compose.yml', 'keep');
        $this->addStack('Evil', $evil, $evil . '/docker-compose.yml');

        $this->manager->removeStack('Evil', true, [], $this->stacksDir);

        $this->assertFileExists($evil . '/docker-compose.yml');
    }

    #[Test]
    public function aSymlinkedStackDirectoryIsNotFollowed(): void
    {
        $target = $this->root . '/appdata';
        mkdir($target);
        file_put_contents($target . '/docker-compose.yml', 'keep');
        symlink($target, $this->stacksDir . '/Linked');
        $this->addStack('Linked', $this->stacksDir . '/Linked', $this->stacksDir . '/Linked/docker-compose.yml');

        $result = $this->manager->removeStack('Linked', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertFileExists($target . '/docker-compose.yml');
        unlink($this->stacksDir . '/Linked');
    }

    #[Test]
    public function aDirectoryAnotherStackStillUsesIsKept(): void
    {
        $dir = $this->addOwnStack('Immich');
        $this->addStack('immich', $dir, $dir . '/docker-compose.yml', null, 200);

        $result = $this->manager->removeStack('Immich', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertFileExists($dir . '/docker-compose.yml');
        $this->assertSame(['immich'], $this->stackNames());
    }

    #[Test]
    public function filesStayWhileAContainerRunsFromTheOwnDirectory(): void
    {
        $dir = $this->addOwnStack('Immich', 100);
        $this->addStack('immich', '/elsewhere', null, null, 200);
        $container = ['id' => 'i', 'name' => '/immich_server', 'labels' => [
            'com.docker.compose.project' => 'immich',
            'com.docker.compose.project.working_dir' => $dir,
        ]];

        $result = $this->manager->removeStack('Immich', true, [$container], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertSame([], $result['files_removed']);
        $this->assertStringContainsString('Containers still run', $result['files_note']);
        $this->assertFileExists($dir . '/docker-compose.yml');
    }

    #[Test]
    public function filesStayWhenARelativeConfigFileResolvesIntoTheOwnDirectory(): void
    {
        $dir = $this->addOwnStack('Immich', 100);
        $this->addStack('immich', '/elsewhere', null, null, 200);
        $container = ['id' => 'i', 'name' => '/immich_server', 'labels' => [
            'com.docker.compose.project' => 'immich',
            'com.docker.compose.project.working_dir' => $this->stacksDir,
            'com.docker.compose.project.config_files' => 'Immich/docker-compose.yml',
        ]];

        $result = $this->manager->removeStack('Immich', true, [$container], $this->stacksDir);

        $this->assertSame([], $result['files_removed']);
        $this->assertFileExists($dir . '/docker-compose.yml');
    }

    #[Test]
    public function filesGoWhileContainersRunFromAnotherDirectory(): void
    {
        // The reporter's case: containers come from the compose.manager
        // directory, so the plugin's copy is redundant and can be deleted.
        $dir = $this->addOwnStack('Immich', 100);
        $this->addStack('immich', '/elsewhere', null, null, 200);

        $result = $this->manager->removeStack('Immich', true, [self::labelled('immich_server', 'immich')], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertTrue($result['directory_removed']);
        $this->assertDirectoryDoesNotExist($dir);
    }

    #[Test]
    public function aFileNameOutsideTheAllowlistIsNeverUnlinked(): void
    {
        $dir = $this->stacksDir . '/Odd';
        mkdir($dir);
        file_put_contents($dir . '/app.db', 'precious');
        file_put_contents($dir . '/secret.txt', 'precious');
        file_put_contents($dir . '/prod.env', 'A=1');
        $this->addStack('Odd', $dir, $dir . '/app.db', $dir . '/prod.env');

        $result = $this->manager->removeStack('Odd', true, [], $this->stacksDir);

        $this->assertTrue($result['success']);
        $this->assertFileExists($dir . '/app.db');
        $this->assertFileExists($dir . '/secret.txt');
        $this->assertFileDoesNotExist($dir . '/prod.env', 'a *.env name is allowed');
        $this->assertFalse($result['directory_removed']);
        $this->assertNotNull($result['files_note']);
    }

    #[Test]
    public function anEmptyListWithADockerErrorIsNotTrusted(): void
    {
        // compose.php answers 503 on this, before removeStack runs.
        $this->assertTrue(ComposeManager::containerListFailed([], 'Docker socket not found: /x'));
        $this->assertFalse(ComposeManager::containerListFailed([], ''));
        $this->assertFalse(ComposeManager::containerListFailed([self::labelled('a', 'a')], 'ignored'));
    }

    #[Test]
    public function aStackWithANameComposeRefusesCanBeRemovedAndStaysGone(): void
    {
        // An import of an earlier version: "Nginx.Test" cannot start or stop.
        $dir = $this->addOwnStack('Nginx.Test');
        $others = [self::labelled('web', 'other')];

        $result = $this->manager->removeStack('Nginx.Test', false, $others, $this->stacksDir);
        $this->assertTrue($result['success']);
        $this->folders->syncComposeStacks($others);

        $this->assertSame(['other'], $this->stackNames());
        $this->assertFileExists($dir . '/docker-compose.yml');
    }

    #[Test]
    public function aContainerOfAnotherProjectDoesNotBlockRemoval(): void
    {
        $this->addOwnStack('Immich');

        $result = $this->manager->removeStack('Immich', false, [self::labelled('web', 'immich')], $this->stacksDir);

        // "immich" is a different project name from "Immich": the sync would
        // not recreate the row from it, so there is nothing to refuse.
        $this->assertTrue($result['success']);
    }
}
