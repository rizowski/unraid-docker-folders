<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * ComposeManager::parseComposeServiceNames, the light YAML read behind the
 * service list of each stack. It needs no database, so the manager is built
 * without its constructor.
 */
final class ComposeServiceNamesTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/compose-names-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0700, true);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
    }

    private function names(array $stack): array
    {
        $manager = (new ReflectionClass(ComposeManager::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(ComposeManager::class, 'parseComposeServiceNames');
        $method->setAccessible(true);
        return $method->invoke($manager, $stack);
    }

    #[Test]
    public function aStackKnownOnlyByItsDirectoryStillListsItsServices(): void
    {
        file_put_contents($this->dir . '/compose.yaml', "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n");

        $this->assertSame(['web', 'db'], $this->names(['compose_file' => null, 'working_dir' => $this->dir]));
    }
}
