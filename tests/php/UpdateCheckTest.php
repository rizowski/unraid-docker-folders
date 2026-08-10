<?php

declare(strict_types=1);

// Load config.php (defines constants + checkAllImageUpdates function)
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

// Load DockerClient so MockDockerClient can extend it
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

// Re-enable error reporting for test visibility (config.php disables it)
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

// --- Stub classes --------------------------------------------------------

class MockDockerClient extends DockerClient
{
    public array $containers = [];
    public array $updateResults = [];
    /** @var array<string, \Throwable> */
    public array $throwOn = [];

    public function __construct()
    {
        // Skip parent – avoids needing a real Docker socket
    }

    public function listContainers($all = true): array
    {
        return $this->containers;
    }

    public function checkImageUpdate($imageName, $localImageId): array
    {
        if (isset($this->throwOn[$imageName])) {
            throw $this->throwOn[$imageName];
        }
        return $this->updateResults[$imageName] ?? [
            'update_available' => false,
            'local_digest' => 'sha256:local123',
            'remote_digest' => 'sha256:remote123',
            'error' => null,
        ];
    }
}

class StubDatabase
{
    private array $settings = [];

    /** @var string[] SQL of every executed query, for cleanup assertions */
    public array $executedQueries = [];

    /** Stale-entry count reported to the cleanup logic */
    public int $staleCount = 0;

    /** Simulates the release-notes read failing (missing table, locked DB, ...) */
    public bool $throwOnFetchAll = false;

    public function setExcludePatterns(string $patterns): void
    {
        $this->settings['update_check_exclude'] = $patterns;
    }

    public function fetchOne(string $sql, array $params = []): array|false
    {
        if (str_contains($sql, 'update_check_exclude')) {
            return isset($this->settings['update_check_exclude'])
                ? ['value' => $this->settings['update_check_exclude']]
                : false;
        }
        return false;
    }

    /** @var array<string, array<string, mixed>> Seeded/written release_notes rows, keyed by repo */
    public array $releaseNotes = [];

    public function query(string $sql, array $params = []): mixed
    {
        $this->executedQueries[] = $sql;

        if (str_contains($sql, 'INSERT OR REPLACE INTO release_notes')) {
            $row = [];
            foreach ($params as $key => $value) {
                $row[ltrim((string) $key, ':')] = $value;
            }
            $this->releaseNotes[$row['repo']] = $row;
        }

        return true;
    }

    public function fetchAll(string $sql, array $params = []): array
    {
        if ($this->throwOnFetchAll) {
            throw new RuntimeException('no such table: release_notes');
        }
        if (!str_contains($sql, 'release_notes')) {
            return [];
        }
        $wanted = array_flip(array_map('strval', $params));
        return array_values(array_filter(
            $this->releaseNotes,
            fn ($row) => isset($wanted[$row['repo']])
        ));
    }

    public function fetchValue(string $sql, array $params = []): mixed
    {
        return $this->staleCount;
    }
}

// --- Tests ---------------------------------------------------------------

final class UpdateCheckTest extends TestCase
{
    private MockDockerClient $docker;
    private StubDatabase $db;
    /** @var string[] */
    private array $logMessages;

    protected function setUp(): void
    {
        $this->docker = new MockDockerClient();
        $this->db = new StubDatabase();
        $this->logMessages = [];
    }

    private function log(): callable
    {
        return function (string $message): void {
            $this->logMessages[] = $message;
        };
    }

    private function makeContainer(string $image, string $imageId = 'sha256:abc123'): array
    {
        return [
            'id' => md5($image . random_int(0, 999999)),
            'name' => str_replace('/', '-', $image),
            'image' => $image,
            'imageId' => $imageId,
            'state' => 'running',
            'status' => 'Up 2 hours',
        ];
    }

    #[Test]
    public function allContainersUpToDate(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(0, $result['newUpdates']);
        $this->assertSame(2, $result['checked']);
        $this->assertSame(0, $result['errors']);
        $this->assertSame(0, $result['skipped']);
        $this->assertCount(2, $result['results']);
        $this->assertFalse($result['results']['nginx:latest']['update_available']);
        $this->assertFalse($result['results']['redis:7']['update_available']);
    }

    #[Test]
    public function someContainersHaveUpdates(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
        ];
        $this->docker->updateResults['postgres:15'] = [
            'update_available' => true,
            'local_digest' => 'sha256:oldpg',
            'remote_digest' => 'sha256:newpg',
            'error' => null,
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['newUpdates']);
        $this->assertSame(3, $result['checked']);
        $this->assertTrue($result['results']['nginx:latest']['update_available']);
        $this->assertFalse($result['results']['redis:7']['update_available']);
        $this->assertTrue($result['results']['postgres:15']['update_available']);
    }

    #[Test]
    public function excludedImagesSkipped(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];
        $this->db->setExcludePatterns('nginx:latest,postgres:15');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['skipped']);
        $this->assertSame(1, $result['checked']);
        $this->assertArrayNotHasKey('nginx:latest', $result['results']);
        $this->assertArrayHasKey('redis:7', $result['results']);
        $this->assertArrayNotHasKey('postgres:15', $result['results']);
    }

    #[Test]
    public function wildcardExcludePatterns(): void
    {
        $this->docker->containers = [
            $this->makeContainer('linuxserver/plex'),
            $this->makeContainer('linuxserver/sonarr'),
            $this->makeContainer('redis:7'),
        ];
        $this->db->setExcludePatterns('linuxserver/*');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['skipped']);
        $this->assertSame(1, $result['checked']);
        $this->assertArrayNotHasKey('linuxserver/plex', $result['results']);
        $this->assertArrayNotHasKey('linuxserver/sonarr', $result['results']);
        $this->assertArrayHasKey('redis:7', $result['results']);
    }

    #[Test]
    public function errorFromCheckImageUpdate(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => false,
            'local_digest' => 'sha256:abc',
            'remote_digest' => null,
            'error' => 'Registry timeout',
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(1, $result['errors']);
        $this->assertSame(2, $result['checked']);
        $this->assertSame('Registry timeout', $result['results']['nginx:latest']['error']);
        $this->assertNull($result['results']['redis:7']['error']);
    }

    #[Test]
    public function fatalExceptionCaughtAndLoopContinues(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->docker->throwOn['nginx:latest'] = new \RuntimeException('Connection reset');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(1, $result['errors']);
        $this->assertSame(2, $result['checked']);
        // Exception caught and recorded
        $this->assertSame('Connection reset', $result['results']['nginx:latest']['error']);
        $this->assertFalse($result['results']['nginx:latest']['update_available']);
        // Loop continued to next image
        $this->assertArrayHasKey('redis:7', $result['results']);
        $this->assertNull($result['results']['redis:7']['error']);
    }

    #[Test]
    public function noContainersReturnsAllZeros(): void
    {
        $this->docker->containers = [];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(0, $result['checked']);
        $this->assertSame(0, $result['skipped']);
        $this->assertSame(0, $result['errors']);
        $this->assertSame(0, $result['newUpdates']);
        $this->assertEmpty($result['results']);
    }

    #[Test]
    public function duplicateImagesCheckedOnce(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest', 'sha256:same1'),
            $this->makeContainer('nginx:latest', 'sha256:same1'),
            $this->makeContainer('redis:7', 'sha256:redis1'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(2, $result['checked']);
        $this->assertCount(2, $result['results']);
        $this->assertSame(1, $result['newUpdates']);
    }

    #[Test]
    public function logCallbackReceivesExpectedMessages(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
        ];
        $this->docker->updateResults['redis:7'] = [
            'update_available' => false,
            'local_digest' => 'sha256:local',
            'remote_digest' => 'sha256:remote',
            'error' => 'Timeout',
        ];
        $this->docker->throwOn['postgres:15'] = new \RuntimeException('Socket error');

        checkAllImageUpdates($this->docker, $this->db, $this->log());

        // Collect log prefixes
        $prefixes = array_map(function ($msg) {
            return explode(' ', $msg, 2)[0];
        }, $this->logMessages);

        $this->assertContains('INFO', $prefixes);
        $this->assertContains('UPDATE', $prefixes);
        $this->assertContains('ERROR', $prefixes);
        $this->assertContains('FATAL', $prefixes);

        // Verify image names appear in logs
        $allLogs = implode("\n", $this->logMessages);
        $this->assertStringContainsString('nginx:latest', $allLogs);
        $this->assertStringContainsString('redis:7', $allLogs);
        $this->assertStringContainsString('postgres:15', $allLogs);
        $this->assertStringContainsString('Socket error', $allLogs);
    }

    // --- Targeted checks (specific containers / compose stacks) ----------

    #[Test]
    public function targetedCheckOnlyChecksRequestedImages(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
            $this->makeContainer('postgres:15'),
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log(), ['nginx:latest', 'redis:7']);

        $this->assertSame(2, $result['checked']);
        $this->assertArrayHasKey('nginx:latest', $result['results']);
        $this->assertArrayHasKey('redis:7', $result['results']);
        $this->assertArrayNotHasKey('postgres:15', $result['results']);
    }

    #[Test]
    public function targetedCheckIgnoresUnknownImages(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log(), ['nginx:latest', 'ghost:5']);

        $this->assertSame(1, $result['checked']);
        $this->assertArrayHasKey('nginx:latest', $result['results']);
        $this->assertArrayNotHasKey('ghost:5', $result['results']);
    }

    #[Test]
    public function targetedCheckStillAppliesExcludePatterns(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->db->setExcludePatterns('nginx:*');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log(), ['nginx:latest', 'redis:7']);

        $this->assertSame(1, $result['skipped']);
        $this->assertSame(1, $result['checked']);
        $this->assertArrayNotHasKey('nginx:latest', $result['results']);
        $this->assertArrayHasKey('redis:7', $result['results']);
    }

    #[Test]
    public function targetedCheckWithEmptyListChecksNothing(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
        ];

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log(), []);

        $this->assertSame(0, $result['checked']);
        $this->assertEmpty($result['results']);
    }

    #[Test]
    public function fullCheckRunsStaleEntryCleanup(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
        ];
        $this->db->staleCount = 3;

        checkAllImageUpdates($this->docker, $this->db, $this->log());

        $deletes = array_filter($this->db->executedQueries, fn ($sql) => str_contains($sql, 'DELETE'));
        $this->assertNotEmpty($deletes, 'Full check should clean up stale image_update_checks entries');
    }

    #[Test]
    public function targetedCheckSkipsStaleEntryCleanup(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->db->staleCount = 3;

        checkAllImageUpdates($this->docker, $this->db, $this->log(), ['nginx:latest']);

        // A targeted check only sees a subset of images — running the cleanup
        // would delete every other image's cached status.
        $deletes = array_filter($this->db->executedQueries, fn ($sql) => str_contains($sql, 'DELETE'));
        $this->assertEmpty($deletes, 'Targeted check must not delete other images\' cached entries');
    }

    // --- Release notes ---------------------------------------------------

    /**
     * Build a $results entry the way checkAllImageUpdates does.
     */
    private function resultEntry(string $image, ?string $repo, bool $updateAvailable): array
    {
        return [
            'image' => $image,
            'local_digest' => 'sha256:local',
            'remote_digest' => 'sha256:remote',
            'update_available' => $updateAvailable,
            'checked_at' => 1700000000,
            'error' => null,
            'source_url' => $repo === null ? null : 'https://github.com/' . $repo,
            'source_repo' => $repo,
            'release' => null,
        ];
    }

    /**
     * A fetcher stub that records calls and replays canned outcomes.
     *
     * @param array<string, array> $outcomes repo => fetchLatest() return value
     * @param string[] $calls Populated with each repo requested, in order
     */
    private function fetcher(array $outcomes, array &$calls): callable
    {
        $default = [
            'status' => 'ok',
            'http' => 200,
            'release' => ['tag' => 'v1', 'name' => '1', 'published_at' => 1, 'url' => 'u', 'summary' => 's'],
        ];
        return function (string $repo) use ($outcomes, &$calls, $default) {
            $calls[] = $repo;
            return $outcomes[$repo] ?? $default;
        };
    }

    private function seedNote(string $repo, string $status, int $fetchedAt): void
    {
        $this->db->releaseNotes[$repo] = [
            'repo' => $repo,
            'tag' => 'v0',
            'name' => '0',
            'published_at' => 1,
            'url' => 'https://example.test',
            'summary' => 'cached',
            'etag' => null,
            'status' => $status,
            'fetched_at' => $fetchedAt,
        ];
    }

    #[Test]
    public function parseRepoAcceptsGithubUrlShapes(): void
    {
        $this->assertSame('grafana/grafana', ReleaseNotes::parseRepo('https://github.com/grafana/grafana'));
        $this->assertSame('grafana/grafana', ReleaseNotes::parseRepo('https://github.com/grafana/grafana/'));
        $this->assertSame('grafana/grafana', ReleaseNotes::parseRepo('https://github.com/grafana/grafana/tree/main'));
        $this->assertSame('grafana/grafana', ReleaseNotes::parseRepo('https://github.com/grafana/grafana.git'));
        $this->assertSame('foo/bar', ReleaseNotes::parseRepo('https://GitHub.com/Foo/Bar'));
        $this->assertSame('foo/bar', ReleaseNotes::parseRepo('https://www.github.com/foo/bar'));
    }

    #[Test]
    public function parseRepoRejectsEverythingElse(): void
    {
        $this->assertNull(ReleaseNotes::parseRepo('https://gitlab.com/foo/bar'));
        $this->assertNull(ReleaseNotes::parseRepo('https://gitea.example.com/foo/bar'));
        $this->assertNull(ReleaseNotes::parseRepo('https://github.com/onlyowner'));
        $this->assertNull(ReleaseNotes::parseRepo('https://github.com/'));
        $this->assertNull(ReleaseNotes::parseRepo('javascript:alert(1)'));
        $this->assertNull(ReleaseNotes::parseRepo(''));
        $this->assertNull(ReleaseNotes::parseRepo(null));
    }

    #[Test]
    public function toPlainTextStripsMarkdownAndMarkup(): void
    {
        $md = "# Heading\n\n- A bullet with [a link](https://x.test) and ![img](https://y.test/i.png)\n"
            . "```\ncode block that should vanish\n```\n"
            . "<script>alert(1)</script>\n"
            . "> quoted **bold** text";

        $text = ReleaseNotes::toPlainText($md);

        $this->assertStringNotContainsString('code block', $text);
        $this->assertStringNotContainsString('<script>', $text);
        $this->assertStringNotContainsString('https://y.test', $text);
        $this->assertStringNotContainsString('](', $text);
        $this->assertStringNotContainsString('**', $text);
        $this->assertStringContainsString('a link', $text);
        $this->assertStringContainsString('quoted bold text', $text);
        $this->assertStringNotContainsString("\n", $text);
    }

    #[Test]
    public function toPlainTextStripsBothEndsOfSingleEmphasis(): void
    {
        $this->assertSame('an italic word', ReleaseNotes::toPlainText('an *italic* word'));
        $this->assertSame('an italic word', ReleaseNotes::toPlainText('an _italic_ word'));
        // Identifiers must survive — they are not emphasis.
        $this->assertSame('use snake_case_names here', ReleaseNotes::toPlainText('use snake_case_names here'));
    }

    #[Test]
    public function toPlainTextTruncatesLongBodies(): void
    {
        $text = ReleaseNotes::toPlainText(str_repeat('word ', 2000));

        $this->assertLessThanOrEqual(ReleaseNotes::SUMMARY_MAX_CHARS + 1, mb_strlen($text));
        $this->assertStringEndsWith('…', $text);
    }

    #[Test]
    public function releaseNotesOnlyFetchedForImagesWithUpdates(): void
    {
        $results = [
            'a:1' => $this->resultEntry('a:1', 'owner/a', true),
            'b:1' => $this->resultEntry('b:1', 'owner/b', false),
        ];
        $calls = [];

        refreshReleaseNotes($results, $this->db, $this->log(), true, 1700000000, $this->fetcher([], $calls));

        $this->assertSame(['owner/a'], $calls);
    }

    #[Test]
    public function releaseNotesDedupeImageTagsSharingARepo(): void
    {
        $results = [
            'grafana:latest' => $this->resultEntry('grafana:latest', 'grafana/grafana', true),
            'grafana:next' => $this->resultEntry('grafana:next', 'grafana/grafana', true),
        ];
        $calls = [];

        refreshReleaseNotes($results, $this->db, $this->log(), true, 1700000000, $this->fetcher([], $calls));

        $this->assertSame(['grafana/grafana'], $calls);
    }

    #[Test]
    public function freshCacheIsNotRefetched(): void
    {
        $now = 1700000000;
        $this->seedNote('owner/a', 'ok', $now - 60);
        $results = ['a:1' => $this->resultEntry('a:1', 'owner/a', true)];
        $calls = [];

        refreshReleaseNotes($results, $this->db, $this->log(), true, $now, $this->fetcher([], $calls));

        $this->assertSame([], $calls);
    }

    #[Test]
    public function notFoundIsNegativeCachedForAWeek(): void
    {
        $now = 1700000000;
        $results = ['a:1' => $this->resultEntry('a:1', 'owner/a', true)];
        $calls = [];
        $notFound = ['status' => 'not_found', 'http' => 404, 'release' => null];

        refreshReleaseNotes($results, $this->db, $this->log(), true, $now, $this->fetcher(['owner/a' => $notFound], $calls));
        $this->assertSame('not_found', $this->db->releaseNotes['owner/a']['status']);
        $this->assertNull($results['a:1']['release'], 'A 404 must not decorate the image with notes');

        // Still inside the 7d TTL a day later.
        $calls = [];
        $results = ['a:1' => $this->resultEntry('a:1', 'owner/a', true)];
        refreshReleaseNotes($results, $this->db, $this->log(), true, $now + 86400, $this->fetcher([], $calls));
        $this->assertSame([], $calls);
    }

    #[Test]
    public function rateLimitWritesNothingAndAbortsTheRun(): void
    {
        $results = [
            'a:1' => $this->resultEntry('a:1', 'owner/a', true),
            'b:1' => $this->resultEntry('b:1', 'owner/b', true),
            'c:1' => $this->resultEntry('c:1', 'owner/c', true),
        ];
        $calls = [];
        $limited = ['status' => 'rate_limited', 'http' => 403, 'release' => null];

        refreshReleaseNotes(
            $results,
            $this->db,
            $this->log(),
            true,
            1700000000,
            $this->fetcher(['owner/a' => $limited, 'owner/b' => $limited, 'owner/c' => $limited], $calls)
        );

        // Aborted after the first 403 rather than burning the rest of the run.
        $this->assertSame(['owner/a'], $calls);
        // And cached nothing: a transient 403 must not suppress notes for hours.
        $this->assertSame([], $this->db->releaseNotes);
    }

    #[Test]
    public function fetchesAreCappedAndTakeTheOldestFirst(): void
    {
        $now = 1700000000;
        $results = [];
        // 25 stale repos, seeded with ascending fetched_at so the expected
        // winners are unambiguous. repo-00 is oldest.
        for ($i = 0; $i < 25; $i++) {
            $repo = sprintf('owner/repo-%02d', $i);
            $results["img-$i:1"] = $this->resultEntry("img-$i:1", $repo, true);
            $this->seedNote($repo, 'ok', $now - 200000 + $i);
        }
        $calls = [];

        refreshReleaseNotes($results, $this->db, $this->log(), true, $now, $this->fetcher([], $calls));

        $this->assertCount(ReleaseNotes::MAX_FETCHES_PER_RUN, $calls);
        $this->assertSame('owner/repo-00', $calls[0]);
        $this->assertSame('owner/repo-19', $calls[ReleaseNotes::MAX_FETCHES_PER_RUN - 1]);
    }

    #[Test]
    public function decoratesImagesWithoutUpdatesFromCache(): void
    {
        $now = 1700000000;
        $this->seedNote('owner/a', 'ok', $now - 60);
        // Not flagged for an update, so never fetched — but the GET and POST
        // payloads must still be shaped the same, so it gets decorated.
        $results = ['a:1' => $this->resultEntry('a:1', 'owner/a', false)];
        $calls = [];

        refreshReleaseNotes($results, $this->db, $this->log(), true, $now, $this->fetcher([], $calls));

        $this->assertSame([], $calls);
        $this->assertSame('v0', $results['a:1']['release']['tag']);
    }

    #[Test]
    public function fetcherFailureLeavesTheResultsIntact(): void
    {
        $results = ['a:1' => $this->resultEntry('a:1', 'owner/a', true)];
        $throwing = function (string $repo): array {
            throw new RuntimeException('DNS is on fire');
        };

        // refreshReleaseNotes lets the throw escape; checkAllImageUpdates is
        // what contains it, so assert both halves of that contract.
        try {
            refreshReleaseNotes($results, $this->db, $this->log(), true, 1700000000, $throwing);
            $this->fail('Expected the fetcher exception to propagate');
        } catch (RuntimeException $e) {
            $this->assertSame('DNS is on fire', $e->getMessage());
        }

        $this->assertTrue($results['a:1']['update_available'], 'Digest results must survive a notes failure');
    }

    #[Test]
    public function notesFailureDoesNotDisturbTheCheckCounters(): void
    {
        $this->docker->containers = [$this->makeContainer('nginx:latest')];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => true,
            'local_digest' => 'sha256:old',
            'remote_digest' => 'sha256:new',
            'error' => null,
            'source_url' => 'https://github.com/nginx/nginx',
        ];
        // Blow up the moment refreshReleaseNotes touches the database.
        $this->db->throwOnFetchAll = true;

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame(1, $result['checked']);
        $this->assertSame(0, $result['errors'], 'A notes failure is not a check failure');
        $this->assertSame(1, $result['newUpdates']);
        $this->assertSame('nginx/nginx', $result['results']['nginx:latest']['source_repo']);
        $this->assertNull($result['results']['nginx:latest']['release']);
        $this->assertNotEmpty(array_filter($this->logMessages, fn ($m) => str_starts_with($m, 'NOTES FATAL')));
    }

    #[Test]
    public function sourceRepoIsRecordedForBothSuccessAndFailure(): void
    {
        $this->docker->containers = [
            $this->makeContainer('nginx:latest'),
            $this->makeContainer('redis:7'),
        ];
        $this->docker->updateResults['nginx:latest'] = [
            'update_available' => false,
            'local_digest' => 'sha256:a',
            'remote_digest' => 'sha256:a',
            'error' => null,
            'source_url' => 'https://github.com/nginx/nginx',
        ];
        $this->docker->throwOn['redis:7'] = new RuntimeException('socket gone');

        $result = checkAllImageUpdates($this->docker, $this->db, $this->log());

        $this->assertSame('nginx/nginx', $result['results']['nginx:latest']['source_repo']);
        $this->assertNull($result['results']['redis:7']['source_repo']);
        $this->assertNull($result['results']['redis:7']['release']);

        $upserts = array_filter($this->db->executedQueries, fn ($sql) => str_contains($sql, 'INSERT OR REPLACE INTO image_update_checks'));
        $this->assertNotEmpty($upserts);
        foreach ($upserts as $sql) {
            $this->assertStringContainsString('source_repo', $sql);
        }
    }
}
