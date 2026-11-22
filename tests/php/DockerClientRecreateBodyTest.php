<?php

declare(strict_types=1);

if (!defined('DOCKER_SOCKET')) {
    define('DOCKER_SOCKET', '/var/run/docker.sock');
}
if (!defined('DOCKER_API_VERSION')) {
    define('DOCKER_API_VERSION', 'v1.41');
}

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerClient.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;

/**
 * The create body of a recreate, from fixtures shared with the GraphQL plugin
 * (packages/unraid-api-plugin-docker-folders/src/updates/__tests__/recreate-fixtures.spec.ts).
 * Both suites must give the same body for the same inspect data.
 */
final class DockerClientRecreateBodyTest extends TestCase
{
    public static function cases(): array
    {
        $cases = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/recreate/cases.json'), true);
        $out = [];
        foreach ($cases as $case) {
            $out[$case['name']] = [$case];
        }
        return $out;
    }

    #[Test]
    #[DataProvider('cases')]
    public function buildsTheSharedFixtureBody(array $case): void
    {
        $body = DockerClient::buildRecreateBody(
            $case['inspect'],
            $case['oldImageConfig'],
            $case['newImageConfig'],
            $case['image']
        );
        // PHP cannot tell {} from []: compare the JSON round trip of both.
        $this->assertEquals($case['expected'], json_decode((string) json_encode($body), true));
    }
}
