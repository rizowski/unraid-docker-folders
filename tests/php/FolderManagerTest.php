<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/FolderManager.php';

// Re-enable error reporting for test visibility
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * FolderManager against a real in-memory SQLite database.
 *
 * Database is a singleton with a private constructor that opens DB_PATH, so
 * the instance is built without its constructor and handed a SQLite3 on
 * ':memory:'. Every migration file is then replayed in sorted order, the same
 * way scripts/migrate.php applies them, which also proves each one parses.
 */
final class FolderManagerTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    /** Migration SQL is read once; every test still gets a fresh database. */
    private static ?array $migrationSql = null;

    private Database $db;
    private FolderManager $manager;

    protected function setUp(): void
    {
        $this->db = self::memoryDatabase();
        $this->manager = new FolderManager($this->db);
    }

    private static function memoryDatabase(): Database
    {
        $ref = new ReflectionClass(Database::class);
        /** @var Database $database */
        $database = $ref->newInstanceWithoutConstructor();

        $sqlite = new SQLite3(':memory:');
        $sqlite->exec('PRAGMA foreign_keys = ON');

        $prop = $ref->getProperty('db');
        $prop->setAccessible(true);
        $prop->setValue($database, $sqlite);

        foreach (self::migrationSql() as $sql) {
            $database->exec($sql);
        }

        return $database;
    }

    /** @return string[] */
    private static function migrationSql(): array
    {
        if (self::$migrationSql === null) {
            $files = glob(self::MIGRATIONS_DIR . '/*.sql');
            self::assertNotFalse($files);
            self::assertNotEmpty($files, 'no migration files found');
            sort($files);

            self::$migrationSql = array_map(static function (string $file): string {
                $sql = file_get_contents($file);
                self::assertNotFalse($sql, "could not read $file");
                return $sql;
            }, $files);
        }

        return self::$migrationSql;
    }

    /** @return array<int, array{container_name: string, position: int}> */
    private function orderRows(): array
    {
        return array_map(
            fn ($row) => ['container_name' => $row['container_name'], 'position' => (int) $row['position']],
            $this->db->fetchAll('SELECT container_name, position FROM unfoldered_order ORDER BY position ASC')
        );
    }

    #[Test]
    public function migrationCreatesUnfolderedOrderTable(): void
    {
        self::assertTrue($this->db->tableExists('unfoldered_order'));
    }

    #[Test]
    public function freshDatabaseHasNoUnfolderedOrder(): void
    {
        self::assertSame([], $this->manager->getUnfolderedOrder());
    }

    #[Test]
    public function setUnfolderedOrderReadsBackInTheGivenOrder(): void
    {
        self::assertTrue($this->manager->setUnfolderedOrder(['b', 'a', 'c']));
        self::assertSame(['b', 'a', 'c'], $this->manager->getUnfolderedOrder());
    }

    #[Test]
    public function secondSetFullyReplacesTheFirst(): void
    {
        $this->manager->setUnfolderedOrder(['b', 'a', 'c']);
        self::assertTrue($this->manager->setUnfolderedOrder(['c', 'x']));

        self::assertSame(['c', 'x'], $this->manager->getUnfolderedOrder());
        self::assertSame(2, $this->db->getRowCount('unfoldered_order'));
    }

    #[Test]
    public function skipsEmptyStringsAndDuplicatesKeepingPositionsContiguous(): void
    {
        self::assertTrue($this->manager->setUnfolderedOrder([
            'plex',
            '',
            'sonarr',
            'plex',
            'radarr',
            'sonarr',
        ]));

        self::assertSame(['plex', 'sonarr', 'radarr'], $this->manager->getUnfolderedOrder());
        self::assertSame(
            [
                ['container_name' => 'plex', 'position' => 0],
                ['container_name' => 'sonarr', 'position' => 1],
                ['container_name' => 'radarr', 'position' => 2],
            ],
            $this->orderRows()
        );
    }

    #[Test]
    public function setWithEmptyListClearsTheOrder(): void
    {
        $this->manager->setUnfolderedOrder(['b', 'a']);
        self::assertTrue($this->manager->setUnfolderedOrder([]));

        self::assertSame([], $this->manager->getUnfolderedOrder());
        self::assertSame(0, $this->db->getRowCount('unfoldered_order'));
    }

    #[Test]
    public function removeContainerByNameDeletesFolderRowAndUnfolderedOrderRow(): void
    {
        $folder = $this->manager->createFolder(['name' => 'Media']);
        self::assertTrue($this->manager->addContainerToFolder($folder['id'], 'id-plex', 'plex'));
        self::assertTrue($this->manager->addContainerToFolder($folder['id'], 'id-sonarr', 'sonarr'));
        $this->manager->setUnfolderedOrder(['plex', 'radarr']);

        $this->manager->removeContainerByName('plex');

        self::assertSame(
            [],
            $this->db->fetchAll('SELECT * FROM container_folders WHERE container_name = ?', ['plex'])
        );
        self::assertSame(1, $this->db->getRowCount('container_folders'));
        self::assertSame(['radarr'], $this->manager->getUnfolderedOrder());
    }

    #[Test]
    public function removeContainerByNameIsANoOpWhenNothingMatches(): void
    {
        $this->manager->setUnfolderedOrder(['plex']);

        $this->manager->removeContainerByName('ghost');

        self::assertSame(0, $this->db->getRowCount('container_folders'));
        self::assertSame(['plex'], $this->manager->getUnfolderedOrder());
    }
}
