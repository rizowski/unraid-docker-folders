<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * compose_auto_install: a user-started install turns it on, the boot restore
 * never does. The download itself needs the network and writes under
 * /usr/lib/docker, so it is not run here. These tests cover the switch and
 * the contract that only an explicit $persist reaches it.
 */
final class ComposeAutoInstallTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private Database $db;
    private ComposeManager $manager;

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

        $this->manager = (new ReflectionClass(ComposeManager::class))->newInstanceWithoutConstructor();
        $dbProp = new ReflectionProperty(ComposeManager::class, 'db');
        $dbProp->setAccessible(true);
        $dbProp->setValue($this->manager, $this->db);
    }

    #[Test]
    public function theSettingIsOffUntilSomethingTurnsItOn(): void
    {
        $this->assertFalse($this->manager->isAutoInstallEnabled());
    }

    #[Test]
    public function enablingTurnsTheSettingOn(): void
    {
        $this->manager->enableAutoInstall();
        $this->assertTrue($this->manager->isAutoInstallEnabled());
    }

    #[Test]
    public function enablingOverwritesAnExplicitOff(): void
    {
        dfmUpsertSetting($this->db, 'compose_auto_install', '0');
        $this->assertFalse($this->manager->isAutoInstallEnabled());

        $this->manager->enableAutoInstall();
        $this->assertTrue($this->manager->isAutoInstallEnabled());
    }

    #[Test]
    public function installDoesNotPersistUnlessAskedTo(): void
    {
        // The boot hook calls it with no argument, so it must default to off.
        $param = (new ReflectionMethod(ComposeManager::class, 'installComposeBinary'))->getParameters()[0];
        $this->assertSame('persist', $param->getName());
        $this->assertFalse($param->getDefaultValue());
    }

    #[Test]
    public function theBannerActionAsksToPersistAndTheBootHookDoesNot(): void
    {
        $base = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/';
        $this->assertStringContainsString('installComposeBinary(true)', file_get_contents($base . 'api/compose.php'));
        $this->assertStringContainsString('$this->installComposeBinary();', file_get_contents($base . 'classes/ComposeManager.php'));
    }
}
