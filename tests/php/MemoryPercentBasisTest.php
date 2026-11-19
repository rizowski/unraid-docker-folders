<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * The memory_percent_basis setting. settings.php is a request handler that
 * ends in exit(), so these tests cover what can be checked without a session:
 * the constant the handler validates against, and that the handler and the
 * settings page use it. The plugin's settings service has the same two values,
 * checked in its own vitest suite.
 */
final class MemoryPercentBasisTest extends TestCase
{
    private const PLUGIN_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern';

    #[Test]
    public function basesAreLimitAndHostWithLimitFirst(): void
    {
        $this->assertSame(['limit', 'host'], MEMORY_PERCENT_BASES);
    }

    #[Test]
    public function settingsEndpointAllowsTheKeyAndValidatesItAgainstTheConstant(): void
    {
        $source = file_get_contents(self::PLUGIN_DIR . '/api/settings.php');
        $this->assertMatchesRegularExpression("/'memory_percent_basis',\s*\n\s*\];/", $source, 'key is in the allowlist');
        $this->assertStringContainsString(
            "\$key === 'memory_percent_basis' && !in_array(\$value, MEMORY_PERCENT_BASES, true)",
            $source
        );
        $this->assertStringContainsString("'Invalid memory_percent_basis', 400", $source);
    }

    #[Test]
    public function settingsPageDefaultsToLimitAndOffersBothValues(): void
    {
        $page = file_get_contents(self::PLUGIN_DIR . '/DockerFolders.page');
        $this->assertStringContainsString("(\$settings['memory_percent_basis'] ?? '') === 'host' ? 'host' : 'limit'", $page);
        $this->assertStringContainsString("saveSetting('memory_percent_basis', this.value)", $page);
        foreach (MEMORY_PERCENT_BASES as $basis) {
            $this->assertStringContainsString("'{$basis}' =>", $page);
        }
    }
}
