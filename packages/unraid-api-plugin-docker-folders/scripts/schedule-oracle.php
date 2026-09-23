<?php
/**
 * Generates __tests__/php-schedule-sequence.fixture.json.
 *
 * Runs a fixed sequence of ScheduleManager calls (create/update/toggle/
 * bulkSetEnabled/bulkDelete) against a temp copy of the plugin's own migrated
 * database, and dumps the full `schedules` table after every step. The vitest
 * differential (`__tests__/schedule.php-parity.spec.ts`) replays the identical
 * sequence through ScheduleService, one step at a time, with the system clock
 * pinned to the same anchor PHP used for that step, and asserts the two tables
 * agree.
 *
 * NEVER run this against a real Unraid box. Every one of these calls ends in
 * CronManager::ensureSchedulerCron(), which rewrites root's live crontab. Run
 * it only in the throwaway php:8.4-cli container:
 *
 *   docker run --rm -v "$(pwd)":/work -w /work php:8.4-cli \
 *     php packages/unraid-api-plugin-docker-folders/scripts/schedule-oracle.php \
 *     > packages/unraid-api-plugin-docker-folders/src/schedules/__tests__/php-schedule-sequence.fixture.json
 *
 * Regenerate only if ScheduleManager's create/update/toggle/bulk methods
 * change. The fixture holds no real server data — every row here is made up
 * for the test.
 */

$backend = __DIR__ . '/../../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern';
if (!is_dir($backend)) {
    fwrite(STDERR, "Cannot find the backend tree at {$backend}\n");
    exit(1);
}

require_once $backend . '/include/config.php';
// config.php sets the process timezone from the (absent, in this container)
// server config, which falls back to something OS-dependent. Pin it
// explicitly so the fixture is reproducible regardless of container image.
date_default_timezone_set('UTC');

require_once $backend . '/classes/Database.php';
require_once $backend . '/classes/CronManager.php';
require_once $backend . '/classes/DockerClient.php';
require_once $backend . '/classes/BackupManager.php';
require_once $backend . '/classes/WebSocketPublisher.php';
require_once $backend . '/classes/ScheduleManager.php';

// CronManager::ensureSchedulerCron() writes a .cron file under CONFIG_DIR on
// every write. That directory does not exist in a bare php:8.4-cli container;
// without it, file_put_contents() emits a warning that would otherwise land
// on stdout next to the JSON. error_reporting(0) below (inherited from
// config.php's production branch) already suppresses it, but create the
// directory anyway so a debug run with DEBUG defined stays clean too.
@mkdir(CONFIG_DIR, 0755, true);

/**
 * Point the Database singleton at a fresh, fully migrated temp copy.
 *
 * Database's constructor is private (singleton). Reflection builds an
 * instance without running it, invokes the constructor by hand against the
 * temp path, then plants that instance as the singleton so every
 * Database::getInstance() call inside ScheduleManager resolves to it.
 */
function freshDatabase(string $migrationsDir): Database
{
    $path = sys_get_temp_dir() . '/dfm-schedule-oracle-' . bin2hex(random_bytes(8)) . '.db';
    if (file_exists($path)) {
        unlink($path);
    }

    $ref = new ReflectionClass(Database::class);
    /** @var Database $instance */
    $instance = $ref->newInstanceWithoutConstructor();
    $ctor = $ref->getConstructor();
    $ctor->setAccessible(true);
    $ctor->invoke($instance, $path);

    $prop = $ref->getProperty('instance');
    $prop->setAccessible(true);
    $prop->setValue(null, $instance);

    foreach (glob($migrationsDir . '/*.sql') as $file) {
        $instance->exec(file_get_contents($file));
    }

    return $instance;
}

/** Every column of every schedules row, ordered the way the UI lists them. */
function dumpSchedules(Database $db): array
{
    return $db->fetchAll('SELECT * FROM schedules ORDER BY id');
}

/**
 * Run the whole fixed sequence once and return [$steps, $crossedMinute].
 *
 * $crossedMinute is true if the run straddled a minute boundary, in which
 * case computeNextRun()'s internal time() call could land in a different
 * bucket than the anchor this script captured for the same step. The caller
 * retries when that happens rather than ship a fixture that could disagree
 * with itself.
 */
function runSequence(string $migrationsDir): array
{
    $db = freshDatabase($migrationsDir);
    $manager = new ScheduleManager();

    $t0 = time();
    $steps = [];

    $capture = function (string $step, callable $call) use (&$steps, $db) {
        $anchor = time();
        $result = $call();
        $steps[] = [
            'step' => $step,
            'anchor' => $anchor,
            'result' => $result,
            'schedules' => dumpSchedules($db),
        ];
        return $result;
    };

    $idA = $capture('create_A_backup', fn () => $manager->createSchedule([
        'name' => 'Nightly backup',
        'target_type' => 'container',
        'target_id' => 'plex',
        'action' => 'backup',
        'cron_expression' => '0 3 * * *',
        'backup_config' => '{"paths":["/config"],"quiesce":"stop"}',
    ]));

    $idB = $capture('create_B_restart_disabled', fn () => $manager->createSchedule([
        'name' => 'Weekly restart',
        'target_type' => 'stack',
        'target_id' => 'media',
        'action' => 'restart',
        'cron_expression' => '0 3 * * 0',
        'enabled' => false,
    ]));

    $idC = $capture('create_C_resume', fn () => $manager->createSchedule([
        'name' => 'Resume plex',
        'target_type' => 'container',
        'target_id' => 'plex',
        'action' => 'resume',
        'cron_expression' => '*/15 * * * *',
        'enabled' => true,
    ]));

    $idD = $capture('create_D_to_delete', fn () => $manager->createSchedule([
        'name' => 'Quick start',
        'target_type' => 'container',
        'target_id' => 'sonarr',
        'action' => 'start',
        'cron_expression' => '*/5 * * * *',
    ]));

    $capture('update_A_name_and_cron', fn () => $manager->updateSchedule($idA, [
        'name' => 'Nightly backup v2',
        'cron_expression' => '30 2 * * *',
    ]));

    // B was created disabled. Re-enabling it without sending cron_expression
    // must still move next_run_at forward off the stale value it was given at
    // creation.
    $capture('update_B_enable_only', fn () => $manager->updateSchedule($idB, [
        'enabled' => true,
    ]));

    $capture('toggle_C_off', fn () => $manager->toggleSchedule($idC, false));

    $capture('bulk_set_enabled', fn () => $manager->bulkSetEnabled([
        ['id' => $idB, 'enabled' => false],
        ['id' => $idC, 'enabled' => true],
        ['id' => 999999, 'enabled' => true], // does not exist: must be skipped, not counted
    ]));

    $capture('bulk_delete', fn () => $manager->bulkDelete([$idD, 999999, 0]));
    // ^ D is real, 999999 is not (PHP counts it anyway — delete() with no
    // matching row is not an error), 0 is falsy and must be skipped.

    $capture('update_A_backup_config_only', fn () => $manager->updateSchedule($idA, [
        'backup_config' => '{"paths":["/config","/data"],"quiesce":"pause"}',
    ]));

    $t1 = time();
    $crossedMinute = intdiv($t0, 60) !== intdiv($t1, 60);

    return [$steps, $crossedMinute];
}

$migrationsDir = $backend . '/migrations';

$attempts = 0;
do {
    [$steps, $crossedMinute] = runSequence($migrationsDir);
    $attempts++;
} while ($crossedMinute && $attempts < 10);

if ($crossedMinute) {
    fwrite(STDERR, "Could not capture a fixture without crossing a minute boundary after {$attempts} attempts\n");
    exit(1);
}

echo json_encode($steps, JSON_PRETTY_PRINT), "\n";
