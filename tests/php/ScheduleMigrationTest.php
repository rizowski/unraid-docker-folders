<?php

declare(strict_types=1);

// Re-enable error reporting for test visibility
error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * Migration 015 rebuilds the schedule tables so the action CHECK accepts
 * 'resume' (issue #7). Runs the real migration files on an in-memory SQLite
 * database with foreign keys on and each file in a transaction, the way
 * scripts/migrate.php applies them.
 */
final class ScheduleMigrationTest extends TestCase
{
    private const MIGRATIONS_DIR = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/migrations';
    private const REBUILD = '015_schedules_allow_resume.sql';

    private SQLite3 $db;

    protected function setUp(): void
    {
        $this->db = new SQLite3(':memory:');
        $this->db->enableExceptions(true);
        $this->db->exec('PRAGMA foreign_keys = ON');

        foreach ($this->migrationFiles() as $file) {
            if (basename($file) >= self::REBUILD) {
                break;
            }
            $this->runMigration($file);
        }
    }

    /** @return string[] */
    private function migrationFiles(): array
    {
        $files = glob(self::MIGRATIONS_DIR . '/*.sql');
        self::assertNotFalse($files);
        sort($files);
        return $files;
    }

    private function runMigration(string $file): void
    {
        $sql = file_get_contents($file);
        self::assertNotFalse($sql, "could not read $file");
        $this->db->exec('BEGIN TRANSACTION');
        $this->db->exec($sql);
        $this->db->exec('COMMIT');
    }

    private function insertSchedule(int $id, string $action): void
    {
        $this->db->exec(
            "INSERT INTO schedules (id, name, target_type, target_id, action, cron_expression, next_run_at, created_at, updated_at)
             VALUES ($id, 'wake', 'container', 'chromium-1', '$action', '45 6 * * 1-5', 1000, 1, 2)"
        );
    }

    #[Test]
    public function resumeIsRejectedBeforeTheRebuild(): void
    {
        $this->expectException(Exception::class);
        $this->expectExceptionMessageMatches('/CHECK constraint failed/');
        $this->insertSchedule(1, 'resume');
    }

    #[Test]
    public function rebuildAcceptsResumeAndKeepsExistingRows(): void
    {
        $this->insertSchedule(7, 'pause');
        $this->db->exec(
            "INSERT INTO schedule_history (id, schedule_id, started_at, finished_at, status, message)
             VALUES (3, 7, 100, 101, 'success', 'Pause succeeded')"
        );

        $this->runMigration(self::MIGRATIONS_DIR . '/' . self::REBUILD);

        $schedule = $this->db->querySingle('SELECT * FROM schedules WHERE id = 7', true);
        self::assertSame('pause', $schedule['action']);
        self::assertSame('45 6 * * 1-5', $schedule['cron_expression']);
        self::assertSame(1000, $schedule['next_run_at']);

        $history = $this->db->querySingle('SELECT * FROM schedule_history WHERE id = 3', true);
        self::assertSame(7, $history['schedule_id']);
        self::assertSame('Pause succeeded', $history['message']);

        $this->insertSchedule(8, 'resume');
        self::assertSame('resume', $this->db->querySingle('SELECT action FROM schedules WHERE id = 8'));

        // Unknown actions are still rejected.
        try {
            $this->insertSchedule(9, 'explode');
            self::fail('invalid action was accepted');
        } catch (Exception $e) {
            self::assertStringContainsString('CHECK constraint failed', $e->getMessage());
        }

        // The rebuilt foreign key still cascades, and no copy tables are left.
        $this->db->exec('DELETE FROM schedules WHERE id = 7');
        self::assertSame(0, $this->db->querySingle('SELECT COUNT(*) FROM schedule_history'));
        self::assertSame(
            0,
            $this->db->querySingle("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '\\_%copy' ESCAPE '\\'")
        );

        $indexes = $this->db->querySingle(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN
             ('idx_schedules_enabled_next', 'idx_schedules_target', 'idx_schedule_history_schedule')"
        );
        self::assertSame(3, $indexes);
    }
}
