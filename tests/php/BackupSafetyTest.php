<?php

declare(strict_types=1);

// BackupManager's constructor opens the database and a Docker socket, so it is
// never instantiated here. Every method under test is public static for that
// reason.
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/BackupManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

final class BackupSafetyTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/backup-safety-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0700, true);
    }

    protected function tearDown(): void
    {
        if ($this->dir === '' || !is_dir($this->dir)) {
            return;
        }
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
    }

    private function writeDatabase(string $name): string
    {
        $path = $this->dir . '/' . $name;
        // The real 16 byte header, then padding. Nothing reads past byte 16.
        file_put_contents($path, "SQLite format 3\0" . str_repeat("\0", 84));
        return $path;
    }

    // --- mounts -------------------------------------------------------------

    private function mounts(): array
    {
        return [
            ['Source' => '/mnt/user/appdata/plex', 'Destination' => '/config'],
            ['Source' => '/mnt/user/media', 'Destination' => '/data'],
            // Nested inside /config on the container side, and somewhere else
            // entirely on the host. The longest match has to win.
            ['Source' => '/mnt/cache/plex-db', 'Destination' => '/config/databases'],
        ];
    }

    #[Test]
    public function aWholeMountMapsToItsSource(): void
    {
        $mapped = BackupManager::mapContainerPath('/config', $this->mounts());

        $this->assertSame('/mnt/user/appdata/plex', $mapped['host_path']);
        $this->assertSame('', $mapped['relative']);
    }

    #[Test]
    public function aTrailingSlashIsStillTheWholeMount(): void
    {
        $mapped = BackupManager::mapContainerPath('/config/', $this->mounts());

        $this->assertSame('/mnt/user/appdata/plex', $mapped['host_path']);
        $this->assertSame('', $mapped['relative']);
    }

    #[Test]
    public function theLongestMatchingMountWins(): void
    {
        // Both /config and /config/databases cover this path. Picking /config
        // would archive the wrong disk entirely.
        $mapped = BackupManager::mapContainerPath('/config/databases/app.db', $this->mounts());

        $this->assertSame('/mnt/cache/plex-db', $mapped['mount_source']);
        $this->assertSame('/mnt/cache/plex-db/app.db', $mapped['host_path']);
    }

    #[Test]
    public function aPathThatClimbsOutOfItsMountIsRejected(): void
    {
        $this->assertNull(BackupManager::mapContainerPath('/config/../../etc/shadow', $this->mounts()));
        $this->assertNull(BackupManager::mapContainerPath('/config/x/../../..', $this->mounts()));
    }

    #[Test]
    public function aPathUnderNoMountIsRejected(): void
    {
        $this->assertNull(BackupManager::mapContainerPath('/etc/shadow', $this->mounts()));
        // A name that merely starts the same is not inside the mount.
        $this->assertNull(BackupManager::mapContainerPath('/config-evil/x', $this->mounts()));
    }

    // --- database detection -------------------------------------------------

    #[Test]
    public function aSqliteFileIsRecognizedByItsHeader(): void
    {
        $this->assertTrue(BackupManager::isSqliteFile($this->writeDatabase('app.db')));
    }

    #[Test]
    public function anythingElseIsNotADatabase(): void
    {
        $text = $this->dir . '/notes.txt';
        file_put_contents($text, 'SQLite is mentioned here but this is plain text');

        $this->assertFalse(BackupManager::isSqliteFile($text));
        $this->assertFalse(BackupManager::isSqliteFile($this->dir . '/does-not-exist'));
        // A directory is not a file, whatever it is named.
        $this->assertFalse(BackupManager::isSqliteFile($this->dir));
    }

    #[Test]
    public function sidecarFilesAreFoundBesideTheDatabase(): void
    {
        $db = $this->writeDatabase('app.db');
        file_put_contents($db . '-wal', 'log');
        file_put_contents($db . '-shm', 'shared');

        // This is the actual corruption fix. A pattern such as /config/*.db
        // matches app.db alone, and that copy is missing every committed
        // transaction still sitting in the write-ahead log.
        $this->assertSame([$db . '-wal', $db . '-shm'], BackupManager::sidecarsFor($db));
    }

    #[Test]
    public function aDatabaseWithNoSidecarsReturnsNothing(): void
    {
        $this->assertSame([], BackupManager::sidecarsFor($this->writeDatabase('clean.db')));
    }

    // --- quiesce mode -------------------------------------------------------

    #[Test]
    public function knownQuiesceModesPassThrough(): void
    {
        $this->assertSame('pause', BackupManager::quiesceModeFor('pause'));
        $this->assertSame('stop', BackupManager::quiesceModeFor('stop'));
        $this->assertSame('none', BackupManager::quiesceModeFor('none'));
        $this->assertSame('stop', BackupManager::quiesceModeFor(' STOP '));
    }

    #[Test]
    public function anUnknownQuiesceModeLeavesTheContainerAlone(): void
    {
        // Failing closed here means "do not touch the container", which is the
        // old behavior, rather than a fatal error mid run.
        $this->assertSame('none', BackupManager::quiesceModeFor('kill'));
        $this->assertSame('none', BackupManager::quiesceModeFor(null));
        $this->assertSame('none', BackupManager::quiesceModeFor(['pause']));
        $this->assertSame('none', BackupManager::quiesceModeFor(''));
    }
}
