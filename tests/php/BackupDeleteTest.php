<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/BackupManager.php';

// Re-enable error reporting for test visibility (config.php disables it)
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * BackupManager::deleteBackup, the one backup method that takes a path from
 * the request and unlinks it.
 *
 * resolveDestination() only accepts a destination under BACKUP_ALLOWED_ROOTS,
 * so the fixtures live under /mnt. That works inside the test container, which
 * runs as root. The DockerClient constructor opens no socket, so the manager
 * can be built against an in-memory database.
 */
final class BackupDeleteTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private string $root = '';
    private string $dest = '';
    private BackupManager $manager;

    protected function setUp(): void
    {
        $this->root = '/mnt/dfm-delete-test-' . bin2hex(random_bytes(6));
        if (!@mkdir($this->root . '/backups/nested', 0700, true) || !@mkdir($this->root . '/sibling', 0700, true)) {
            $this->markTestSkipped('Cannot create fixtures under /mnt');
        }
        $this->dest = $this->root . '/backups';

        $ref = new ReflectionClass(Database::class);
        $db = $ref->newInstanceWithoutConstructor();
        $prop = $ref->getProperty('db');
        $prop->setAccessible(true);
        $prop->setValue($db, new SQLite3(':memory:'));

        $files = glob(self::MIGRATIONS_DIR . '/*.sql');
        sort($files);
        foreach ($files as $file) {
            $db->exec(file_get_contents($file));
        }
        $db->query(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('backup_destination', ?, 0)",
            [$this->dest]
        );

        $instance = $ref->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, $db);

        $this->manager = new BackupManager();
    }

    protected function tearDown(): void
    {
        $instance = (new ReflectionClass(Database::class))->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, null);

        if ($this->root !== '' && is_dir($this->root)) {
            exec('rm -rf ' . escapeshellarg($this->root));
        }
    }

    private function file(string $relative): string
    {
        $path = $this->root . '/' . $relative;
        file_put_contents($path, 'x');
        return $path;
    }

    #[Test]
    public function anArchiveInTheDestinationIsDeleted(): void
    {
        $path = $this->file('backups/plex.2026-09-22_031500.tar.gz');

        $this->assertTrue($this->manager->deleteBackup($path));
        $this->assertFileDoesNotExist($path);
    }

    #[Test]
    public function anyOtherFileInTheDestinationIsKept(): void
    {
        $path = $this->file('backups/notes.txt');

        $this->assertFalse($this->manager->deleteBackup($path));
        $this->assertFileExists($path);
    }

    #[Test]
    public function anArchiveNameInASubdirectoryIsKept(): void
    {
        $path = $this->file('backups/nested/plex.2026-09-22_031500.tar.gz');

        $this->assertFalse($this->manager->deleteBackup($path));
        $this->assertFileExists($path);
    }

    #[Test]
    public function anArchiveNameOutsideTheDestinationIsKept(): void
    {
        $path = $this->file('sibling/plex.2026-09-22_031500.tar.gz');

        $this->assertFalse($this->manager->deleteBackup($path));
        $this->assertFileExists($path);

        // The same file, reached by climbing out of the destination.
        $this->assertFalse($this->manager->deleteBackup($this->dest . '/../sibling/plex.2026-09-22_031500.tar.gz'));
        $this->assertFileExists($path);
    }
}
