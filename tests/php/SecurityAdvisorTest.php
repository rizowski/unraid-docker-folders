<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/SecurityAdvisor.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * SecurityAdvisor against a real in-memory SQLite database, built the same way
 * FolderManagerTest builds one: the singleton is instantiated without its
 * constructor, handed a ':memory:' handle, and every migration is replayed in
 * sorted order, which also proves 017 parses.
 */
final class SecurityAdvisorTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private static ?array $migrationSql = null;

    private Database $db;
    private SecurityAdvisor $advisor;

    protected function setUp(): void
    {
        $this->db = self::memoryDatabase();
        $this->advisor = new SecurityAdvisor($this->db);
    }

    /**
     * The allowlist is the `FINDING_TYPES` list in
     * src/frontend/src/utils/securityFindings.ts, spelled a second time because
     * PHP and TypeScript share no source. Spelling it a third time here is the
     * point: a one-sided edit fails this test instead of shipping a type the
     * backend rejects with a 400. securityFindings.spec.ts asserts the same six.
     */
    #[Test]
    public function allowlistMatchesTheFrontendList(): void
    {
        $this->assertSame([
            'privileged',
            'docker-socket',
            'host-network',
            'added-capabilities',
            'broad-mount',
            'forced-root',
        ], SecurityAdvisor::FINDING_TYPES);
    }

    #[Test]
    public function noDismissalsToStart(): void
    {
        $this->assertSame([], $this->advisor->listDismissals());
    }

    #[Test]
    public function dismissThenList(): void
    {
        $this->advisor->dismiss('plex', 'privileged');

        $this->assertSame(
            [['container_name' => 'plex', 'finding_type' => 'privileged']],
            $this->advisor->listDismissals()
        );
    }

    #[Test]
    public function dismissingTwiceStoresOneRow(): void
    {
        $this->advisor->dismiss('plex', 'privileged');
        $this->advisor->dismiss('plex', 'privileged');

        $this->assertCount(1, $this->advisor->listDismissals());
    }

    #[Test]
    public function oneFindingTypeDoesNotSilenceAnother(): void
    {
        $this->advisor->dismiss('plex', 'privileged');

        $this->assertSame(
            [['container_name' => 'plex', 'finding_type' => 'privileged']],
            $this->advisor->listDismissals()
        );

        $this->advisor->dismiss('plex', 'docker-socket');
        $this->assertCount(2, $this->advisor->listDismissals());
    }

    #[Test]
    public function dismissalsAreKeyedPerContainer(): void
    {
        $this->advisor->dismiss('plex', 'privileged');
        $this->advisor->dismiss('sonarr', 'privileged');

        $this->assertCount(2, $this->advisor->listDismissals());
    }

    #[Test]
    public function restoreRemovesOnlyThatRow(): void
    {
        $this->advisor->dismiss('plex', 'privileged');
        $this->advisor->dismiss('plex', 'host-network');

        $this->advisor->restore('plex', 'privileged');

        $this->assertSame(
            [['container_name' => 'plex', 'finding_type' => 'host-network']],
            $this->advisor->listDismissals()
        );
    }

    #[Test]
    public function restoringSomethingNeverDismissedIsHarmless(): void
    {
        $this->advisor->restore('plex', 'privileged');
        $this->assertSame([], $this->advisor->listDismissals());
    }

    #[Test]
    public function unknownFindingTypeIsRejected(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->advisor->dismiss('plex', 'made-up');
    }

    #[Test]
    public function unknownFindingTypeIsRejectedOnRestoreToo(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->advisor->restore('plex', 'made-up');
    }

    #[Test]
    public function emptyContainerNameIsRejected(): void
    {
        $this->expectException(InvalidArgumentException::class);
        $this->advisor->dismiss('   ', 'privileged');
    }

    #[Test]
    public function everyFindingTypeIsAccepted(): void
    {
        foreach (SecurityAdvisor::FINDING_TYPES as $type) {
            $this->advisor->dismiss('plex', $type);
        }

        $this->assertCount(count(SecurityAdvisor::FINDING_TYPES), $this->advisor->listDismissals());
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
}
