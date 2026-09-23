<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * scripts/db-copy.php, which the .plg uses for its database backups and its
 * restore after a failed migration. The database is in use during an install,
 * so each test keeps a connection open with commits still in the WAL.
 */
final class DbCopyScriptTest extends TestCase
{
  private const SCRIPT = __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/scripts/db-copy.php';

  private string $dir;
  private SQLite3 $writer;

  protected function setUp(): void
  {
    $this->dir = sys_get_temp_dir() . '/dbcopy-' . bin2hex(random_bytes(4));
    mkdir($this->dir);
    $this->writer = new SQLite3($this->dir . '/data.db');
    $this->writer->exec('PRAGMA journal_mode = WAL');
    // Keep the commits in the WAL, the way a busy database has them.
    $this->writer->exec('PRAGMA wal_autocheckpoint = 0');
    $this->writer->exec('CREATE TABLE t (v TEXT)');
    $this->writer->exec("INSERT INTO t VALUES ('a'), ('b')");
  }

  protected function tearDown(): void
  {
    $this->writer->close();
    foreach (glob($this->dir . '/*') ?: [] as $file) {
      unlink($file);
    }
    rmdir($this->dir);
  }

  private function runScript(string ...$args): int
  {
    $cmd = 'php ' . escapeshellarg(self::SCRIPT) . ' ' . implode(' ', array_map('escapeshellarg', $args)) . ' 2>/dev/null';
    exec($cmd, $out, $code);
    return $code;
  }

  private function rowCount(string $path): int
  {
    $db = new SQLite3($path, SQLITE3_OPEN_READONLY);
    try {
      return (int) $db->querySingle('SELECT count(*) FROM t');
    } finally {
      $db->close();
    }
  }

  #[Test]
  public function backup_includes_commits_still_in_the_wal(): void
  {
    $this->assertSame(0, $this->runScript('backup', $this->dir . '/data.db', $this->dir . '/bak.db'));
    $this->assertSame(2, $this->rowCount($this->dir . '/bak.db'));
  }

  #[Test]
  public function restore_reaches_connections_that_are_already_open(): void
  {
    $this->assertSame(0, $this->runScript('backup', $this->dir . '/data.db', $this->dir . '/bak.db'));
    $this->writer->exec("INSERT INTO t VALUES ('c')");
    $reader = new SQLite3($this->dir . '/data.db', SQLITE3_OPEN_READONLY);
    $this->assertSame(3, (int) $reader->querySingle('SELECT count(*) FROM t'));

    $this->assertSame(0, $this->runScript('restore', $this->dir . '/bak.db', $this->dir . '/data.db'));

    $this->assertSame(2, (int) $reader->querySingle('SELECT count(*) FROM t'));
    $this->assertSame(2, (int) $this->writer->querySingle('SELECT count(*) FROM t'));
    $this->assertSame('ok', $this->writer->querySingle('PRAGMA integrity_check'));
    $reader->close();
  }

  #[Test]
  public function fails_on_a_missing_source_or_bad_arguments(): void
  {
    $this->assertSame(1, $this->runScript('backup', $this->dir . '/missing.db', $this->dir . '/x.db'));
    $this->assertSame(2, $this->runScript('copy', $this->dir . '/data.db', $this->dir . '/x.db'));
    $this->assertFileDoesNotExist($this->dir . '/x.db');
  }
}
