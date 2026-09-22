<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ComposeManager.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * ComposeManager::execCommand, which runs every short compose command.
 *
 * It needs no database, so the manager is built without its constructor and
 * the private method is reached by reflection.
 */
final class ComposeExecTest extends TestCase
{
    private function exec(string $cmd, int $timeout): array
    {
        $manager = (new ReflectionClass(ComposeManager::class))->newInstanceWithoutConstructor();
        $method = new ReflectionMethod(ComposeManager::class, 'execCommand');
        $method->setAccessible(true);
        return $method->invoke($manager, $cmd, $timeout);
    }

    #[Test]
    public function aCommandReturnsItsOutputAndExitCode(): void
    {
        $ok = $this->exec('echo hello', 10);
        $this->assertTrue($ok['success']);
        $this->assertSame("hello\n", $ok['output']);
        $this->assertSame(0, $ok['exit_code']);

        $fail = $this->exec('echo broken >&2; exit 3', 10);
        $this->assertFalse($fail['success']);
        $this->assertSame(3, $fail['exit_code']);
        $this->assertSame("broken\n", $fail['error']);
    }

    #[Test]
    public function aCommandThatRunsTooLongIsStopped(): void
    {
        $start = time();
        $result = $this->exec('sleep 20', 1);

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('timed out', $result['error']);
        $this->assertLessThan(10, time() - $start);
    }

    #[Test]
    public function aFullStderrPipeDoesNotHang(): void
    {
        // 200 KB on stderr is more than a pipe holds. Reading stdout to the
        // end first would wait forever here.
        $result = $this->exec("head -c 200000 /dev/zero | tr '\\\\0' x >&2; echo done", 20);

        $this->assertSame("done\n", $result['output']);
        $this->assertTrue($result['success']);
    }
}
