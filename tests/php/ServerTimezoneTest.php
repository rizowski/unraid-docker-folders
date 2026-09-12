<?php

declare(strict_types=1);

// Load config.php (defines detectServerTimezone() and sets the timezone)
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

// Re-enable error reporting for test visibility (config.php disables it)
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

final class ServerTimezoneTest extends TestCase
{
    /** @var string[] Temp files/dirs created by a test, removed in tearDown */
    private array $cleanupPaths = [];

    protected function tearDown(): void
    {
        foreach (array_reverse($this->cleanupPaths) as $path) {
            if (is_link($path) || is_file($path)) {
                @unlink($path);
            } elseif (is_dir($path)) {
                @rmdir($path);
            }
        }
        $this->cleanupPaths = [];
    }

    private function tempPath(string $suffix): string
    {
        $path = sys_get_temp_dir() . '/sdt_' . bin2hex(random_bytes(6)) . $suffix;
        $this->cleanupPaths[] = $path;
        return $path;
    }

    #[Test]
    public function readsTimeZoneFromIdentCfg(): void
    {
        $identCfg = $this->tempPath('_ident.cfg');
        file_put_contents($identCfg, "timeZone=\"Europe/Berlin\"\n");

        $result = detectServerTimezone($identCfg, '/nonexistent/localtime');

        $this->assertSame('Europe/Berlin', $result);
    }

    #[Test]
    public function fallsBackToLocaltimeSymlinkWhenIdentValueIsInvalid(): void
    {
        $identCfg = $this->tempPath('_ident.cfg');
        file_put_contents($identCfg, "timeZone=\"Not/ARealZone\"\n");

        // Build a fake zoneinfo tree: <dir>/zoneinfo/Asia/Tokyo, with a
        // symlink pointing at it, mimicking /etc/localtime on a real box.
        $zoneinfoDir = $this->tempPath('_zoneinfo');
        mkdir($zoneinfoDir);
        mkdir($zoneinfoDir . '/Asia', 0777, true);
        $this->cleanupPaths[] = $zoneinfoDir . '/Asia';
        $tokyoFile = $zoneinfoDir . '/Asia/Tokyo';
        file_put_contents($tokyoFile, '');
        $this->cleanupPaths[] = $tokyoFile;

        $localtimeLink = $this->tempPath('_localtime');
        symlink($tokyoFile, $localtimeLink);

        $result = detectServerTimezone($identCfg, $localtimeLink);

        $this->assertSame('Asia/Tokyo', $result);
    }

    #[Test]
    public function fallsBackToUtcWhenNeitherSourceIsUsable(): void
    {
        $result = detectServerTimezone('/nonexistent/ident.cfg', '/nonexistent/localtime');

        $this->assertSame('UTC', $result);
    }
}
