<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/BackupManager.php';
require_once __DIR__ . '/PostgresBackupTest.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * BackupManager::backupPostgres end to end, with FakePostgresDocker for the
 * exec calls and the real tar. One archive per database, Keep per database.
 *
 * The fixtures live under /mnt, because resolveDestination() only accepts a
 * destination under BACKUP_ALLOWED_ROOTS. See BackupDeleteTest.
 */
final class PostgresBackupRunTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private string $dest = '';
    private FakePostgresDocker $docker;
    private BackupManager $manager;

    protected function setUp(): void
    {
        $this->dest = '/mnt/dfm-pg-run-test-' . bin2hex(random_bytes(6));
        if (!@mkdir($this->dest, 0700, true)) {
            $this->markTestSkipped('Cannot create fixtures under /mnt');
        }

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
        $instance = $ref->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, $db);

        $this->manager = new BackupManager();
        $this->docker = new FakePostgresDocker();
        $client = new ReflectionProperty(BackupManager::class, 'dockerClient');
        $client->setAccessible(true);
        $client->setValue($this->manager, $this->docker);
    }

    protected function tearDown(): void
    {
        $instance = (new ReflectionClass(Database::class))->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, null);

        if ($this->dest !== '' && is_dir($this->dest)) {
            exec('rm -rf ' . escapeshellarg($this->dest));
        }
    }

    private function backUp(array $databases, int $retention = 5): array
    {
        return $this->manager->backupPostgres(
            'container',
            'db',
            ['credentials' => 'env', 'databases' => $databases],
            $this->dest,
            $retention
        );
    }

    /** @return string[] The names in the destination, sorted. */
    private function names(): array
    {
        $names = array_values(array_diff(scandir($this->dest), ['.', '..']));
        sort($names);
        return $names;
    }

    #[Test]
    public function writesOneArchivePerDatabase(): void
    {
        $result = $this->backUp(['app', 'my db']);

        $this->assertTrue($result['success'], $result['message']);
        $names = $this->names();
        $this->assertCount(2, $names);
        $this->assertMatchesRegularExpression('/^db\.app\.\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/', $names[0]);
        $this->assertMatchesRegularExpression('/^db\.my-db\.\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/', $names[1]);

        exec('tar tzf ' . escapeshellarg($this->dest . '/' . $names[1]), $members);
        sort($members);
        $this->assertSame(['./', './manifest.json', './my-db.dump'], $members);

        // No staging directory stays behind.
        $this->assertSame([], glob($this->dest . '/.dfm-staging-*') ?: []);
    }

    #[Test]
    public function oneFailedDatabaseDoesNotStopTheOthers(): void
    {
        $this->docker->answers['missing'] = ['ok' => false, 'exit_code' => 1, 'error' => '',
            'stderr' => 'pg_dump: error: database "missing" does not exist'];

        $result = $this->backUp(['missing', 'app']);

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('failed for 1 of 2 databases', $result['message']);
        $this->assertStringContainsString('missing: pg_dump: error: database "missing" does not exist', $result['message']);
        $this->assertStringContainsString('Created: db.app.', $result['message']);
        $this->assertCount(1, $this->names());
        $this->assertSame([], glob($this->dest . '/.dfm-staging-*') ?: []);
    }

    #[Test]
    public function keepCountsPerDatabase(): void
    {
        // Two older archives of "app", one of "other", one file-mode archive
        // of the container. Keep 2 prunes only the oldest "app".
        foreach (['db.app.2020-01-01_000000.tar.gz', 'db.app.2020-01-02_000000.tar.gz',
                  'db.other.2020-01-01_000000.tar.gz', 'db.2020-01-01_000000.tar.gz'] as $i => $name) {
            file_put_contents($this->dest . '/' . $name, 'x');
            touch($this->dest . '/' . $name, 1577836800 + $i * 86400);
        }

        $result = $this->backUp(['app'], 2);

        $this->assertTrue($result['success'], $result['message']);
        $names = $this->names();
        $this->assertNotContains('db.app.2020-01-01_000000.tar.gz', $names);
        $this->assertContains('db.app.2020-01-02_000000.tar.gz', $names);
        $this->assertContains('db.other.2020-01-01_000000.tar.gz', $names);
        $this->assertContains('db.2020-01-01_000000.tar.gz', $names);
        $this->assertStringContainsString('pruned 1 old backup(s)', $result['message']);
    }

    #[Test]
    public function theBackupListAddsTheDatabaseSeries(): void
    {
        $this->manager->backupPostgres('container', 'db', ['credentials' => 'env', 'databases' => ['app']], $this->dest, 5);
        file_put_contents($this->dest . '/db.web.2020-01-01_000000.tar.gz', 'x');

        Database::getInstance()->query(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('backup_destination', ?, 0)",
            [$this->dest]
        );

        $this->manager->backupPostgres('stack', 'immich', ['service' => 'database', 'credentials' => 'env', 'databases' => ['app']], $this->dest, 5);
        // A stack's own scope already takes the extra database segment.
        $stack = array_column($this->manager->listBackups('stack', 'immich'), 'filename');
        $this->assertCount(1, $stack);
        $this->assertStringStartsWith('immich.database.app.', $stack[0]);

        $plain = array_column($this->manager->listBackups('container', 'db'), 'filename');
        $this->assertSame([], $plain);

        // Only the named series, so a stack "db" with service "web" stays out.
        $listed = array_column($this->manager->listBackups('container', 'db', ['db.app']), 'filename');
        $this->assertCount(1, $listed);
        $this->assertStringStartsWith('db.app.', $listed[0]);
    }
}
