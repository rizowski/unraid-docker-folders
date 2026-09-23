<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/BackendWatchdog.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * BackendWatchdog::decide, which switches a server back to PHP when the
 * GraphQL backend breaks, and dfmClassifyGraphqlProbe, which reads the probe
 * it acts on. Only the pure halves: the live half restarts the Unraid API.
 */
final class BackendWatchdogTest extends TestCase
{
    /** A GraphQL-mode server whose heartbeat has been stale long enough to act. */
    private function brokenInputs(array $overrides = []): array
    {
        return array_merge([
            'mode' => 'graphql',
            'heartbeatAge' => 900,
            'sinceInstall' => 3600,
            'staleFor' => BackendWatchdog::STALE_GRACE,
            'apiRunning' => true,
            'probe' => 'load-failed',
            'installed' => true,
            'marker' => false,
        ], $overrides);
    }

    #[Test]
    public function doesNothingInPhpModeOrWhenTheModeIsUnreadable(): void
    {
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['mode' => 'php'])));
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['mode' => null])));
    }

    #[Test]
    public function doesNothingWhileTheHeartbeatIsFresh(): void
    {
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['heartbeatAge' => DFM_RUNNER_ALIVE_STALE_SECONDS])));
    }

    #[Test]
    public function treatsAMissingHeartbeatAsStale(): void
    {
        $this->assertSame('rollback', BackendWatchdog::decide($this->brokenInputs(['heartbeatAge' => null])));
    }

    #[Test]
    public function waitsOutTheGraceAfterAnInstall(): void
    {
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['sinceInstall' => 0])));
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['sinceInstall' => BackendWatchdog::INSTALL_GRACE - 1])));
    }

    #[Test]
    public function waitsUntilTheHeartbeatHasBeenStaleForTheGrace(): void
    {
        $this->assertSame('wait', BackendWatchdog::decide($this->brokenInputs(['staleFor' => 0])));
        $this->assertSame('wait', BackendWatchdog::decide($this->brokenInputs(['staleFor' => BackendWatchdog::STALE_GRACE - 1])));
    }

    #[Test]
    public function leavesAStoppedApiAlone(): void
    {
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['apiRunning' => false, 'probe' => null])));
    }

    #[Test]
    public function rollsBackWhenTheApiRunsWithoutTheBackend(): void
    {
        $this->assertSame('rollback', BackendWatchdog::decide($this->brokenInputs(['probe' => 'load-failed'])));
        $this->assertSame('rollback', BackendWatchdog::decide($this->brokenInputs(['probe' => 'not-installed', 'installed' => false])));
    }

    #[Test]
    public function removesTheBackendWhenGraphqlIsDownWhileItIsInstalled(): void
    {
        $this->assertSame('rollback-and-remove', BackendWatchdog::decide($this->brokenInputs(['probe' => 'offline'])));
        $this->assertSame('rollback-and-remove', BackendWatchdog::decide($this->brokenInputs(['probe' => 'no-api'])));
    }

    #[Test]
    public function removesAtMostOnce(): void
    {
        $this->assertSame('rollback', BackendWatchdog::decide($this->brokenInputs(['probe' => 'offline', 'marker' => true])));
        $this->assertSame('rollback', BackendWatchdog::decide($this->brokenInputs(['probe' => 'offline', 'installed' => false])));
    }

    #[Test]
    public function keepsGraphqlWhenTheBackendStillAnswers(): void
    {
        $this->assertSame('none', BackendWatchdog::decide($this->brokenInputs(['probe' => 'ready'])));
    }

    #[Test]
    public function classifiesTheProbeAnswer(): void
    {
        $installed = fn () => true;
        $missing = fn () => false;
        // An unauthenticated answer still names the field: it is in the schema.
        $unauthenticated = '{"errors":[{"message":"Invalid CSRF token","path":["dockerFoldersInfo"],"extensions":{"code":"UNAUTHENTICATED"}}],"data":null}';
        $this->assertSame('ready', dfmClassifyGraphqlProbe($unauthenticated, $missing));
        $this->assertSame('ready', dfmClassifyGraphqlProbe('{"data":{"dockerFoldersInfo":{"version":"1"}}}', $missing));

        $invalid = '{"errors":[{"message":"Cannot query field \"dockerFoldersInfo\" on type \"Query\".","extensions":{"code":"GRAPHQL_VALIDATION_FAILED"}}]}';
        $this->assertSame('load-failed', dfmClassifyGraphqlProbe($invalid, $installed));
        $this->assertSame('not-installed', dfmClassifyGraphqlProbe($invalid, $missing));

        $this->assertSame('offline', dfmClassifyGraphqlProbe('{"errors":[{"message":"Graphql is offline"}]}', $installed));
        $this->assertSame('offline', dfmClassifyGraphqlProbe('<html>502 Bad Gateway</html>', $installed));
    }
}
