<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/PostgresBackup.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Stands in for DockerClient. Records every exec and answers from a script.
 */
final class FakePostgresDocker
{
    /** @var array<int, array{cmd: string[], env: string[]}> */
    public array $calls = [];
    /** @var string[] */
    public array $env = ['PG_MAJOR=16', 'POSTGRES_USER=app', 'POSTGRES_PASSWORD=from-env'];
    /** @var array<string, array> keyed by the database name, or 'version' */
    public array $answers = [];

    public function findContainersByLabels(array $labels)
    {
        return $labels === ['com.docker.compose.project' => 'immich', 'com.docker.compose.service' => 'database']
            ? [['id' => 'id-stack', 'name' => 'immich-database-1']]
            : [];
    }

    public function inspectContainerRaw($id)
    {
        $names = ['db' => 'id-plain', 'id-stack' => 'id-stack', 'id-plain' => 'id-plain'];
        if (!isset($names[$id])) {
            return null;
        }
        return [
            'Id' => $names[$id],
            'Name' => $names[$id] === 'id-plain' ? '/db' : '/immich-database-1',
            'Config' => ['Env' => $this->env],
            'State' => ['Running' => true],
        ];
    }

    public function execCapture($id, array $cmd, array $env = [], $timeout = 30)
    {
        $this->calls[] = ['cmd' => $cmd, 'env' => $env];
        if ($cmd[0] === 'pg_dump') {
            return $this->answers['version'] ?? ['ok' => true, 'exit_code' => 0, 'stderr' => '', 'error' => '', 'stdout' => "pg_dump (PostgreSQL) 16.4\n"];
        }
        return ['ok' => true, 'exit_code' => 0, 'stderr' => '', 'error' => '', 'stdout' => "app\npostgres\n"];
    }

    public function execRun($id, array $cmd, array $env, callable $onStdout, $timeout = 60)
    {
        $this->calls[] = ['cmd' => $cmd, 'env' => $env];
        $db = end($cmd);
        if (isset($this->answers[$db])) {
            return $this->answers[$db];
        }
        $onStdout("PGDMP-{$db}");
        return ['ok' => true, 'exit_code' => 0, 'stderr' => '', 'error' => ''];
    }
}

final class PostgresBackupTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/pg-backup-' . bin2hex(random_bytes(6));
        mkdir($this->dir, 0700, true);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->dir);
    }

    /** A config with custom credentials, the case with the most to check. */
    private static function config(array $pg = [], array $extra = []): array
    {
        return array_merge([
            'mode' => 'postgres',
            'paths' => [],
            'postgres' => array_merge(
                ['credentials' => 'custom', 'user' => 'postgres', 'password' => 'secret', 'databases' => ['app']],
                $pg
            ),
        ], $extra);
    }

    private static function check(array $config, string $type = 'container', bool $required = true): ?string
    {
        return PostgresBackup::validateConfig($config, $type, $required);
    }

    #[Test]
    public function acceptsAValidConfig(): void
    {
        $this->assertNull(self::check(self::config()));
    }

    #[Test]
    public function envCredentialsNeedNoUserOrPassword(): void
    {
        $this->assertNull(self::check(self::config(['credentials' => 'env', 'user' => null, 'password' => null])));
        // No credentials key at all means env.
        $this->assertNull(self::check(['postgres' => ['databases' => ['app']]]));
        $this->assertNotNull(self::check(self::config(['credentials' => 'vault'])));
    }

    public static function badDatabaseNames(): array
    {
        return [
            'leading dash reads as an option' => ['-Fp'],
            'equals reads as a connection string' => ['host=evil dbname=x'],
            'empty' => [''],
            'too long' => [str_repeat('a', 64)],
            'NUL' => ["a\0b"],
            'not a string' => [5],
            'URI reads as a connection string' => ['postgresql://evil/x'],
            'short URI, any case' => ['POSTGRES://evil/x'],
        ];
    }

    #[Test]
    #[DataProvider('badDatabaseNames')]
    public function rejectsUnsafeDatabaseNames($name): void
    {
        $this->assertNotNull(self::check(self::config(['databases' => [$name]])));
    }

    #[Test]
    public function allowsSlashesInADatabaseNameBecauseFilesAreNumbered(): void
    {
        $this->assertNull(self::check(self::config(['databases' => ['../etc/x']])));
    }

    #[Test]
    public function rejectsBadUsersAndDuplicatesAndMissingPassword(): void
    {
        $this->assertNotNull(self::check(self::config(['user' => '-U'])));
        $this->assertNotNull(self::check(self::config(['user' => 'a b'])));
        $this->assertNotNull(self::check(self::config(['databases' => ['a', 'a']])));
        $this->assertNotNull(self::check(self::config(['databases' => []])));
        $this->assertNotNull(self::check(self::config(['password' => ''])));
        $this->assertNull(self::check(self::config(['password' => '']), 'container', false));
        $this->assertNotNull(self::check(self::config(['password' => str_repeat('x', 1025)])));
    }

    #[Test]
    public function aStackNeedsAService(): void
    {
        $this->assertNotNull(self::check(self::config(), 'stack'));
        $this->assertNotNull(self::check(self::config(['service' => '../x']), 'stack'));
        $this->assertNull(self::check(self::config(['service' => 'database']), 'stack'));
    }

    #[Test]
    public function normalizeKeepsOnlyKnownKeys(): void
    {
        $out = PostgresBackup::normalizeConfig(self::config(['extra' => 1, 'service' => 'dropped'], [
            'quiesce' => 'stop', 'destination' => '/mnt/user/b', 'retention_count' => '3', 'junk' => true,
        ]), 'container');

        $this->assertSame([
            'mode' => 'postgres',
            'paths' => [],
            'postgres' => ['credentials' => 'custom', 'user' => 'postgres', 'password' => 'secret', 'databases' => ['app']],
            'destination' => '/mnt/user/b',
            'retention_count' => 3,
        ], $out);
    }

    #[Test]
    public function normalizeStoresNoCredentialsForEnv(): void
    {
        $out = PostgresBackup::normalizeConfig(self::config(['credentials' => 'env']), 'container');
        $this->assertSame(['credentials' => 'env', 'databases' => ['app']], $out['postgres']);
    }

    #[Test]
    public function normalizeKeepsTheServiceOfAStack(): void
    {
        $out = PostgresBackup::normalizeConfig(self::config(['service' => 'database']), 'stack');
        $this->assertSame('database', $out['postgres']['service']);
    }

    #[Test]
    public function redactRemovesThePassword(): void
    {
        $out = PostgresBackup::redactConfig(self::config());
        $this->assertArrayNotHasKey('password', $out['postgres']);
        $this->assertTrue($out['postgres']['password_set']);

        $none = PostgresBackup::redactConfig(self::config(['password' => null]));
        $this->assertFalse($none['postgres']['password_set']);

        $files = ['paths' => ['/data']];
        $this->assertSame($files, PostgresBackup::redactConfig($files));
    }

    #[Test]
    public function mergeKeepsTheStoredPasswordOnlyWhenLeftOut(): void
    {
        $stored = json_encode(self::config(['password' => 'old']));

        $kept = PostgresBackup::mergeStoredPassword(self::config(['password' => '']), $stored);
        $this->assertSame('old', $kept['postgres']['password']);

        $changed = PostgresBackup::mergeStoredPassword(self::config(['password' => 'new']), $stored);
        $this->assertSame('new', $changed['postgres']['password']);

        $env = PostgresBackup::mergeStoredPassword(self::config(['password' => '', 'credentials' => 'env']), $stored);
        $this->assertSame('', $env['postgres']['password']);
    }

    #[Test]
    public function mergeKeepsNoPasswordForAnotherUserOrService(): void
    {
        $stored = json_encode(self::config(['password' => 'old', 'service' => 'db']));

        $otherUser = PostgresBackup::mergeStoredPassword(self::config(['password' => '', 'service' => 'db', 'user' => 'other']), $stored);
        $this->assertSame('', $otherUser['postgres']['password']);

        $otherService = PostgresBackup::mergeStoredPassword(self::config(['password' => '', 'service' => 'db2']), $stored);
        $this->assertSame('', $otherService['postgres']['password']);

        $same = PostgresBackup::mergeStoredPassword(self::config(['password' => '', 'service' => 'db']), $stored);
        $this->assertSame('old', $same['postgres']['password']);
    }

    #[Test]
    public function prepareStoresARedactableConfigAndKeepsThePassword(): void
    {
        $first = ScheduleManager::prepareBackupConfig(self::config(), 'container', null);
        $this->assertSame('secret', json_decode($first, true)['postgres']['password']);

        $second = ScheduleManager::prepareBackupConfig(self::config(['password' => '']), 'container', $first);
        $this->assertSame('secret', json_decode($second, true)['postgres']['password']);
    }

    #[Test]
    public function prepareRefusesAStackWithNoService(): void
    {
        $this->expectException(InvalidArgumentException::class);
        ScheduleManager::prepareBackupConfig(self::config(), 'stack', null);
    }

    #[Test]
    public function prepareAcceptsAStackService(): void
    {
        $json = ScheduleManager::prepareBackupConfig(self::config(['service' => 'database']), 'stack', null);
        $this->assertSame('database', json_decode($json, true)['postgres']['service']);
    }

    #[Test]
    public function prepareRefusesANewCustomScheduleWithNoPassword(): void
    {
        $this->expectException(InvalidArgumentException::class);
        ScheduleManager::prepareBackupConfig(self::config(['password' => '']), 'container', null);
    }

    #[Test]
    public function prepareLeavesFileModeAlone(): void
    {
        $files = ['paths' => ['/config'], 'quiesce' => 'pause'];
        $this->assertSame(json_encode($files), ScheduleManager::prepareBackupConfig($files, 'container', null));
    }

    #[Test]
    public function postgresModeNeverQuiesces(): void
    {
        $schedule = ['action' => 'backup', 'backup_config' => json_encode(self::config([], ['quiesce' => 'stop']))];
        $this->assertSame('none', ScheduleManager::scheduleQuiesceMode($schedule));
    }

    #[Test]
    public function detectsPostgresFromEnv(): void
    {
        $this->assertTrue(PostgresBackup::envLooksLikePostgres(['PG_MAJOR=16']));
        $this->assertTrue(PostgresBackup::envLooksLikePostgres(['BITNAMI_APP_NAME=postgresql']));
        $this->assertFalse(PostgresBackup::envLooksLikePostgres(['PATH=/bin', 'POSTGRES_PASSWORD=x']));
    }

    #[Test]
    public function infoNeverReturnsThePassword(): void
    {
        $info = (new PostgresBackup(new FakePostgresDocker()))->info('db');
        $this->assertSame(
            ['is_postgres' => true, 'running' => true, 'env_user' => 'app', 'has_env_password' => true],
            $info
        );
    }

    #[Test]
    public function resolvesAContainerOrAStackService(): void
    {
        $pg = new PostgresBackup(new FakePostgresDocker());
        $this->assertSame(['id' => 'id-plain', 'name' => 'db', 'prefix' => 'db'], $pg->resolveTarget('container', 'db'));
        $this->assertSame(
            ['id' => 'id-stack', 'name' => 'immich-database-1', 'prefix' => 'immich.database'],
            $pg->resolveTarget('stack', 'immich', 'database')
        );
        $this->assertNull($pg->resolveTarget('stack', 'immich', 'redis'));
        $this->assertNull($pg->resolveTarget('container', 'immich'));
    }

    #[Test]
    public function envCredentialsComeFromTheContainer(): void
    {
        $docker = new FakePostgresDocker();
        $pg = new PostgresBackup($docker);
        $this->assertSame(['user' => 'app', 'password' => 'from-env'], $pg->resolveCredentials('db', ['credentials' => 'env']));

        // No POSTGRES_USER means the image's default superuser, and no
        // password means no PGPASSWORD: the image trusts local connections.
        $docker->env = ['PG_MAJOR=16'];
        $this->assertSame(['user' => 'postgres', 'password' => null], $pg->resolveCredentials('db', ['credentials' => 'env']));
    }

    #[Test]
    public function customCredentialsIgnoreTheContainer(): void
    {
        $pg = new PostgresBackup(new FakePostgresDocker());
        $this->assertSame(
            ['user' => 'backup', 'password' => 'pw'],
            $pg->resolveCredentials('db', ['credentials' => 'custom', 'user' => 'backup', 'password' => 'pw'])
        );
    }

    #[Test]
    public function listDatabasesPassesThePasswordInEnvOnly(): void
    {
        $docker = new FakePostgresDocker();
        $result = (new PostgresBackup($docker))->listDatabases('db', 'app', 'pw');

        $this->assertSame(['app', 'postgres'], $result['databases']);
        $this->assertSame(['PGPASSWORD=pw'], $docker->calls[0]['env']);
        $this->assertNotContains('pw', $docker->calls[0]['cmd']);
    }

    #[Test]
    public function dumpOneWritesASanitizedFileAndAManifest(): void
    {
        $docker = new FakePostgresDocker();
        $pg = new PostgresBackup($docker);
        $prepared = $pg->prepareDump('db', ['credentials' => 'env', 'databases' => ['../evil']]);
        $this->assertTrue($prepared['success'], $prepared['message']);

        $result = $pg->dumpOne('db', $prepared, '../evil', $this->dir);

        $this->assertTrue($result['success'], $result['message']);
        $this->assertSame('PGDMP-../evil', file_get_contents($this->dir . '/evil.dump'));
        $manifest = json_decode(file_get_contents($this->dir . '/manifest.json'), true);
        $this->assertSame('../evil', $manifest['database']);
        $this->assertSame('evil.dump', $manifest['file']);
        $this->assertSame('app', $manifest['user']);
        $this->assertSame('pg_dump (PostgreSQL) 16.4', $manifest['pg_dump_version']);
        $this->assertSame(['pg_dump', '-U', 'app', '-Fc', '-d', '../evil'], $docker->calls[1]['cmd']);
        $this->assertSame(['PGPASSWORD=from-env'], $docker->calls[1]['env']);
        $this->assertSame(['evil.dump', 'manifest.json'], array_values(array_diff(scandir($this->dir), ['.', '..'])));
    }

    #[Test]
    public function dumpOneReportsWhyTheDatabaseFailed(): void
    {
        $docker = new FakePostgresDocker();
        $docker->answers['missing'] = ['ok' => false, 'exit_code' => 1, 'error' => '',
            'stderr' => "pg_dump: error: database \"missing\" does not exist\nmore"];
        $pg = new PostgresBackup($docker);
        $config = ['credentials' => 'custom', 'user' => 'app', 'password' => 'pw', 'databases' => ['missing']];
        $result = $pg->dumpOne('db', $pg->prepareDump('db', $config), 'missing', $this->dir);

        $this->assertFalse($result['success']);
        $this->assertSame('pg_dump: error: database "missing" does not exist', $result['message']);
        $this->assertStringNotContainsString('pw', $result['message']);
    }

    #[Test]
    public function prepareDumpExplainsAMissingPgDump(): void
    {
        $docker = new FakePostgresDocker();
        $docker->answers['version'] = ['ok' => false, 'exit_code' => 127, 'stderr' => '', 'error' => '', 'stdout' => ''];
        $pg = ['credentials' => 'custom', 'user' => 'a', 'password' => 'p', 'databases' => ['x']];
        $result = (new PostgresBackup($docker))->prepareDump('db', $pg);

        $this->assertFalse($result['success']);
        $this->assertStringContainsString('pg_dump was not found', $result['message']);
    }

    #[Test]
    public function refusesDatabasesThatShareAFileName(): void
    {
        $config = self::config(['databases' => ['my db', 'my-db']]);
        $this->assertSame(
            'Databases my db and my-db map to the same file name',
            PostgresBackup::validateConfig($config, 'container')
        );
        $this->assertSame(
            'Database ___ has no letters or digits to name its backup file',
            PostgresBackup::validateConfig(self::config(['databases' => ['___']]), 'container')
        );
    }

    #[Test]
    public function listsTheArchivePrefixesOfAContainersPostgresSchedules(): void
    {
        $schedules = [
            ['target_id' => 'db', 'backup_config' => self::config(['databases' => ['app', 'my db']])],
            ['target_id' => 'db', 'backup_config' => ['paths' => ['/config']]],
            ['target_id' => 'other', 'backup_config' => self::config(['databases' => ['x']])],
        ];

        $this->assertSame(['db.app', 'db.my-db'], PostgresBackup::archivePrefixesFor($schedules, 'container', 'db'));
        // A stack's own scope already lists "<project>.<service>.<db>".
        $this->assertSame([], PostgresBackup::archivePrefixesFor($schedules, 'stack', 'db'));
    }
}
