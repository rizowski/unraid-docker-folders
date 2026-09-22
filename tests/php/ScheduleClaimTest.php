<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';
require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';

// Re-enable error reporting for test visibility (config.php disables it)
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * ScheduleManager::claimSlot, the compare-and-set that keeps two runners from
 * running one slot. The Unraid API plugin's runner and run-schedules.php can
 * both find a schedule due in the same minute, and the flock only keeps PHP
 * from racing itself.
 *
 * Built on an in-memory database the same way FolderManagerTest does it.
 */
final class ScheduleClaimTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';

    private Database $db;
    private ScheduleManager $manager;

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

        $instance = $ref->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, $this->db);

        $this->manager = new ScheduleManager();
    }

    protected function tearDown(): void
    {
        $instance = (new ReflectionClass(Database::class))->getProperty('instance');
        $instance->setAccessible(true);
        $instance->setValue(null, null);
    }

    private function dueSchedule(int $nextRunAt): array
    {
        $id = $this->db->insert('schedules', [
            'name' => 'Backup',
            'target_type' => 'container',
            'target_id' => 'plex',
            'action' => 'restart',
            'cron_expression' => '*/5 * * * *',
            'enabled' => 1,
            'next_run_at' => $nextRunAt,
            'created_at' => 0,
            'updated_at' => 0,
        ]);
        return $this->db->fetchOne('SELECT * FROM schedules WHERE id = ?', [$id]);
    }

    private function claim(array $schedule, int $now): bool
    {
        $method = new ReflectionMethod(ScheduleManager::class, 'claimSlot');
        $method->setAccessible(true);
        return $method->invoke($this->manager, $schedule, $now);
    }

    #[Test]
    public function theFirstRunnerTakesTheSlotAndMovesItForward(): void
    {
        $now = time();
        $schedule = $this->dueSchedule($now - 5);

        $this->assertTrue($this->claim($schedule, $now));

        $next = (int) $this->db->fetchValue('SELECT next_run_at FROM schedules WHERE id = ?', [$schedule['id']]);
        $this->assertSame(ScheduleManager::computeNextRun('*/5 * * * *', $now), $next);
    }

    #[Test]
    public function aSecondRunnerHoldingTheSameReadLosesTheSlot(): void
    {
        $now = time();
        $schedule = $this->dueSchedule($now - 5);

        $this->assertTrue($this->claim($schedule, $now));
        $this->assertFalse($this->claim($schedule, $now));
    }

    #[Test]
    public function aDisabledScheduleCannotBeClaimed(): void
    {
        $now = time();
        $schedule = $this->dueSchedule($now - 5);
        $this->db->update('schedules', ['enabled' => 0], 'id = ?', [$schedule['id']]);

        $this->assertFalse($this->claim($schedule, $now));
    }
}
