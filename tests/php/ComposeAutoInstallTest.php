<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * ComposeManager with the download and the three install paths replaced, so
 * installComposeBinary() runs for real without the network or /usr/lib.
 */
class StubbedComposeManager extends ComposeManager
{
    public ?string $body = null;
    public string $binary = '';
    public string $cache = '';
    public string $sha = '';

    protected function binaryPath() { return $this->binary; }
    protected function cachePath() { return $this->cache; }
    protected function binarySha256() { return $this->sha; }

    protected function downloadFile($url, $dest)
    {
        if ($this->body === null) {
            return ['success' => false, 'error' => 'Download failed: stub (HTTP 500)'];
        }
        file_put_contents($dest, $this->body);
        return ['success' => true, 'error' => null];
    }
}

/**
 * compose_auto_install: a user-started install turns it on, the boot restore
 * never does, and a failed flash copy is reported as a warning.
 */
final class ComposeAutoInstallTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';
    private const CONTENT = 'compose-bytes';

    private Database $db;
    private StubbedComposeManager $manager;
    private string $dir;

    protected function setUp(): void
    {
        $ref = new ReflectionClass(Database::class);
        $this->db = $ref->newInstanceWithoutConstructor();
        $prop = $ref->getProperty('db');
        $prop->setAccessible(true);
        $prop->setValue($this->db, new SQLite3(':memory:'));

        $files = glob(self::MIGRATIONS_DIR . '/*.sql');
        sort($files);
        foreach ($files as $file) {
            $this->db->exec(file_get_contents($file));
        }

        $this->dir = sys_get_temp_dir() . '/dfm-autoinstall-' . bin2hex(random_bytes(4));
        mkdir($this->dir . '/flash', 0777, true);

        $this->manager = (new ReflectionClass(StubbedComposeManager::class))->newInstanceWithoutConstructor();
        $dbProp = new ReflectionProperty(ComposeManager::class, 'db');
        $dbProp->setAccessible(true);
        $dbProp->setValue($this->manager, $this->db);

        $this->manager->body = self::CONTENT;
        $this->manager->binary = $this->dir . '/cli-plugins/docker-compose';
        $this->manager->cache = $this->dir . '/flash/docker-compose';
        $this->manager->sha = hash('sha256', self::CONTENT);
    }

    protected function tearDown(): void
    {
        $files = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($this->dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($files as $file) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($this->dir);
    }

    private function setting(): ?string
    {
        $row = $this->db->fetchOne("SELECT value FROM settings WHERE key = 'compose_auto_install'");
        return $row ? $row['value'] : null;
    }

    #[Test]
    public function aUserStartedInstallTurnsTheSettingOnAndWritesTheFlashCopy(): void
    {
        $this->assertSame(['success' => true, 'error' => null], $this->manager->installComposeBinary(true));
        $this->assertSame('1', $this->setting());
        $this->assertSame(self::CONTENT, file_get_contents($this->manager->cache));
        $this->assertSame(self::CONTENT, file_get_contents($this->manager->binary));
    }

    #[Test]
    public function anInstallWithoutPersistLeavesTheSettingUnset(): void
    {
        $this->assertTrue($this->manager->installComposeBinary()['success']);
        $this->assertNull($this->setting());
        $this->assertFileDoesNotExist($this->manager->cache);
    }

    #[Test]
    public function anInstallWithoutPersistLeavesAnExplicitOffAlone(): void
    {
        dfmUpsertSetting($this->db, 'compose_auto_install', '0');
        $this->assertTrue($this->manager->installComposeBinary()['success']);
        $this->assertSame('0', $this->setting());
        $this->assertFileDoesNotExist($this->manager->cache);
    }

    #[Test]
    public function aUserStartedInstallTurnsAnExplicitOffBackOn(): void
    {
        dfmUpsertSetting($this->db, 'compose_auto_install', '0');
        $this->manager->installComposeBinary(true);
        $this->assertSame('1', $this->setting());
    }

    #[Test]
    public function aFailedDownloadLeavesTheSettingUnset(): void
    {
        $this->manager->body = null;
        $result = $this->manager->installComposeBinary(true);
        $this->assertFalse($result['success']);
        $this->assertNull($this->setting());
    }

    #[Test]
    public function aBinaryThatFailsTheHashCheckLeavesTheSettingUnset(): void
    {
        $this->manager->body = 'tampered';
        $result = $this->manager->installComposeBinary(true);
        $this->assertFalse($result['success']);
        $this->assertStringContainsString('SHA256', $result['error']);
        $this->assertNull($this->setting());
        $this->assertFileDoesNotExist($this->manager->binary);
    }

    #[Test]
    public function aFailedFlashCopyStillSucceedsButReturnsTheWarning(): void
    {
        $this->manager->cache = $this->dir . '/no-such-dir/docker-compose';
        $result = $this->manager->installComposeBinary(true);

        $this->assertTrue($result['success']);
        $this->assertNull($result['error']);
        $this->assertSame(ComposeManager::FLASH_COPY_WARNING, $result['warning']);
        $this->assertSame('1', $this->setting());
        $this->assertFileExists($this->manager->binary);
    }

    #[Test]
    public function theSettingIsOffUntilSomethingTurnsItOn(): void
    {
        $this->assertFalse($this->manager->isAutoInstallEnabled());
        $this->manager->enableAutoInstall();
        $this->assertTrue($this->manager->isAutoInstallEnabled());
    }

    #[Test]
    public function theBannerActionAsksToPersistAndTheBootHookDoesNot(): void
    {
        $base = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/';
        $this->assertStringContainsString('installComposeBinary(true)', file_get_contents($base . 'api/compose.php'));
        $this->assertStringContainsString('$this->installComposeBinary();', file_get_contents($base . 'classes/ComposeManager.php'));
    }
}
